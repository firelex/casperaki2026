import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Router } from 'express';
import { z } from 'zod';
import { serviceSpec } from '../services/registry.ts';
import { getServiceStatus, startService } from '../services/serviceManager.ts';

type JobState = 'running' | 'done' | 'error';
type VocalProvider = 'ace-step';
type VocalFileKind = 'full' | 'vocals' | 'no_vocals';

interface VocalJob {
  id: string;
  provider: VocalProvider;
  state: JobState;
  createdAt: string;
  updatedAt: string;
  error: string | null;
  files: Partial<Record<VocalFileKind, string>>;
}

const JOBS = new Map<string, VocalJob>();
const OUT_ROOT = resolve(process.cwd(), 'services', '_serving', 'vocal-pipelines');
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

const AceInput = z.object({
  referencePath: z.string().min(1),
  prompt: z.string().min(1).default('pop vocal topline over this Casperaki backing track'),
  lyrics: z.string().optional(),
  audioDuration: z.number().positive().max(600).optional(),
  styleStrength: z.number().min(0).max(1).default(0.45),
  seed: z.number().int().optional(),
  vocalLanguage: z.string().default('en'),
  // 'style' = text2music conditioned on a reference; 'remix' = ACE cover;
  // 'layer' = ACE `lego`, generate one stem (track_name) locked to the source.
  referenceMode: z.enum(['style', 'remix', 'layer']).default('style'),
  separateVocals: z.boolean().default(true),
  // Text prompt handed to SAM-Audio when isolating the vocal from the mix. The
  // inclusive phrasing matters: a bare "vocals" misses *rapped*/spoken delivery,
  // so describe every vocal type to catch sung, rap and spoken toplines alike.
  separationPrompt: z.string().min(1).default('all human vocals, whether sung, rapped or spoken'),
  // Layer-mode (`lego`) extras + musical constraints forwarded to ACE.
  trackName: z.string().min(1).optional(),
  guidanceScale: z.number().positive().max(50).optional(),
  bpm: z.number().int().positive().max(400).optional(),
  keyScale: z.string().min(1).optional(),
  timeSignature: z.string().min(1).optional(),
});

function statusFor(err: any): number {
  return typeof err?.status === 'number' ? err.status : 500;
}

function newJob(provider: VocalProvider): VocalJob {
  const now = new Date().toISOString();
  const job: VocalJob = {
    id: randomUUID().replace(/-/g, ''),
    provider,
    state: 'running',
    createdAt: now,
    updatedAt: now,
    error: null,
    files: {},
  };
  JOBS.set(job.id, job);
  return job;
}

function updateJob(job: VocalJob, patch: Partial<VocalJob>): void {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
}

function normalizeLocalPath(input: string): string {
  const trimmed = input.trim();
  const wslPrefix = /^\\\\wsl\$\\Ubuntu[\\/]/i;
  if (wslPrefix.test(trimmed)) {
    return `/${trimmed.replace(wslPrefix, '').replace(/\\/g, '/')}`;
  }
  return resolve(trimmed);
}

async function assertLocalAudioFile(input: string): Promise<string> {
  const path = normalizeLocalPath(input);
  const root = resolve(process.cwd(), '..', '..');
  const rel = path.startsWith(root) ? path.slice(root.length) : '';
  if (!rel || rel.startsWith('..')) {
    throw Object.assign(new Error(`referencePath must be inside the Casperaki workspace: ${path}`), { status: 400 });
  }
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) {
    throw Object.assign(new Error(`referencePath is not a file: ${path}`), { status: 400 });
  }
  return path;
}

async function waitForReady(serviceId: string): Promise<string> {
  const spec = serviceSpec(serviceId);
  if (!spec) throw Object.assign(new Error(`unknown service: ${serviceId}`), { status: 404 });
  let status = getServiceStatus(spec);
  if (status.readyState === 'stopped') status = startService(spec);
  if (status.readyState === 'error') throw new Error(status.error ?? `${spec.label} failed to start`);

  const started = Date.now();
  while (Date.now() - started < DEFAULT_TIMEOUT_MS) {
    status = getServiceStatus(spec);
    if (status.readyState === 'ready') return status.url;
    if (status.readyState === 'error') throw new Error(status.error ?? `${spec.label} failed to start`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`${spec.label} did not become ready before timeout`);
}

async function submitHarnessJob(baseUrl: string, params: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${baseUrl}/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error ?? `generate failed: HTTP ${res.status}`);
  return String(json.job_id);
}

async function waitHarnessJob(baseUrl: string, jobId: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < DEFAULT_TIMEOUT_MS) {
    const res = await fetch(`${baseUrl}/result?job=${encodeURIComponent(jobId)}`);
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error ?? `result failed: HTTP ${res.status}`);
    if (json.state === 'done') return;
    if (json.state === 'error') throw new Error(json.error ?? 'generation failed');
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`generation job ${jobId} did not finish before timeout`);
}

async function downloadHarnessFile(baseUrl: string, jobId: string, outPath: string): Promise<void> {
  const res = await fetch(`${baseUrl}/file?job=${encodeURIComponent(jobId)}`);
  if (!res.ok || !res.body) throw new Error(`file download failed: HTTP ${res.status}`);
  await mkdir(dirname(outPath), { recursive: true });
  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(outPath));
}

// Isolate the sung topline from a finished mix using the already-registered
// SAM-Audio service (text-prompted source separation). We only ever need the
// vocal stem, so we ask for the `target` sound and let SAM return a single wav.
async function isolateVocalsWithSam(inputAudio: string, outDir: string, description: string): Promise<string> {
  const baseUrl = await waitForReady('sam-audio');
  const jobId = await submitHarnessJob(baseUrl, {
    audio: await fileToBase64(inputAudio),
    audio_filename: basename(inputAudio),
    description,
    output: 'target',
  });
  await waitHarnessJob(baseUrl, jobId);

  const vocals = join(outDir, 'vocals.wav');
  await downloadHarnessFile(baseUrl, jobId, vocals);
  return vocals;
}

async function fileToBase64(path: string): Promise<string> {
  return (await readFile(path)).toString('base64');
}

async function runAcePipeline(job: VocalJob, input: z.infer<typeof AceInput>): Promise<void> {
  try {
    const referencePath = await assertLocalAudioFile(input.referencePath);
    const outDir = join(OUT_ROOT, job.id);
    await mkdir(outDir, { recursive: true });
    const baseUrl = await waitForReady('ace-step');
    const params: Record<string, unknown> = {
      prompt: input.prompt,
      lyrics: input.lyrics,
      vocal_language: input.vocalLanguage,
      reference_audio: await fileToBase64(referencePath),
      reference_filename: basename(referencePath),
      reference_mode: input.referenceMode,
      style_strength: input.styleStrength,
    };
    // Only the free-running 'style' path needs an explicit length; 'remix' and
    // 'layer' lock to the source track's duration.
    if (input.referenceMode === 'style') params.audio_duration = input.audioDuration ?? 30;
    if (input.seed !== undefined) params.seed = input.seed;
    if (input.trackName) params.track_name = input.trackName;
    if (input.guidanceScale !== undefined) params.guidance_scale = input.guidanceScale;
    if (input.bpm !== undefined) params.bpm = input.bpm;
    if (input.keyScale) params.key_scale = input.keyScale;
    if (input.timeSignature) params.time_signature = input.timeSignature;

    const aceJobId = await submitHarnessJob(baseUrl, params);
    await waitHarnessJob(baseUrl, aceJobId);

    const full = join(outDir, 'ace-full.mp3');
    await downloadHarnessFile(baseUrl, aceJobId, full);
    job.files.full = full;
    updateJob(job, { files: job.files });

    if (input.separateVocals) {
      job.files.vocals = await isolateVocalsWithSam(full, outDir, input.separationPrompt);
      updateJob(job, { files: job.files });
    }
    updateJob(job, { state: 'done', files: job.files });
  } catch (err: any) {
    updateJob(job, { state: 'error', error: String(err?.message ?? err) });
  }
}

export function vocalGenerationsRouter(): Router {
  const r = Router();

  r.post('/vocal-generations/ace', (req, res) => {
    try {
      const input = AceInput.parse(req.body ?? {});
      const job = newJob('ace-step');
      void runAcePipeline(job, input);
      res.status(202).json(job);
    } catch (err: any) {
      res.status(statusFor(err)).json({ error: String(err?.message ?? err) });
    }
  });

  r.get('/vocal-generations/:jobId', (req, res) => {
    const job = JOBS.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'unknown vocal generation job' });
    return res.json(job);
  });

  r.get('/vocal-generations/:jobId/file', (req, res) => {
    const job = JOBS.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'unknown vocal generation job' });
    const kind = z.enum(['full', 'vocals', 'no_vocals']).catch('vocals').parse(req.query.kind);
    const file = job.files[kind];
    if (job.state !== 'done' || !file) return res.status(404).json({ error: `no ${kind} file for job` });
    res.setHeader('content-type', kind === 'full' && file.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav');
    res.setHeader('content-disposition', `inline; filename="${basename(file)}"`);
    createReadStream(file).pipe(res);
    return undefined;
  });

  return r;
}
