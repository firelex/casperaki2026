// An in-process stand-in for the vocals service (svc-vocals on the serving harness): the harness's job contract
// (POST /generate, GET /result, GET /file, POST /cancel; an unknown job answers 404 {"error": "unknown job"}) with
// scripted stages. Each poll of /result finishes one more step; a held stage stays on its first step until released.
// Steps and their files are named as pipeline/sing.py, pipeline/transcribe.py and pipeline/add_singer.py name them; the sing stage makes one
// take per sung section's lead and per backing line.

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

interface Step { id: string; label: string; state: 'running' | 'done' | 'failed'; started: number; finished: number | null; text: string; numbers: Record<string, number>; files: string[] }
interface Job {
  id: string;
  stage: string;
  params: Record<string, unknown>;
  state: 'running' | 'done' | 'error';
  error: string | null;
  script: { id: string; label: string; numbers?: Record<string, number>; files?: string[] }[];
  shown: Step[];
  result: unknown;
}

export interface FakeVocalsService {
  readonly url: string;
  /** Every job submitted, in order. */
  readonly jobs: Job[];
  /** Job ids /cancel was called for. */
  readonly cancels: string[];
  /** Job ids /result was asked for, in order. */
  readonly polls: string[];
  /** "<job>/<name>" of every step file sent, in order. */
  readonly fileFetches: string[];
  /** The sung pitch of the transcribe stage's i-th note (default 60 + i % 5). */
  setTranscribeMidi(fn: (i: number) => number): void;
  /** Keeps jobs of a stage on their first step until `release`. */
  hold(stage: string): void;
  release(stage: string): void;
  /** Forget every job (a service restart): /result and /file answer 404 from now on. */
  lose(): void;
  stop(): Promise<void>;
}

/** Half a second of a quiet tone: 8 kHz, 16-bit mono. */
export function toneWav(seconds = 0.5): Buffer {
  const rate = 8000;
  const n = Math.round(rate * seconds);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(3000 * Math.sin((2 * Math.PI * 440 * i) / rate)), 44 + i * 2);
  return buf;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/gu, '_').replace(/^_+|_+$/gu, '');

/** The sing stage's steps in pipeline/sing.py's order and file names: one take per sung section's lead and per
 *  backing line. */
function singScript(params: Record<string, unknown>) {
  const sections = params['sections'] as { segment: string; notes: unknown[] }[];
  const backings = params['backings'] as { segment: string; track: string; notes: unknown[] }[];
  const leads = sections.map((s) => ({ segment: s.segment, track: 'Vocal', tag: s.segment, chain: `chain:${s.segment}`, take: `take_${s.segment}_vocal.wav` }));
  const lines = backings.map((b) => {
    const tag = `${b.segment}_${slug(b.track)}`;
    return { segment: b.segment, track: b.track, tag, chain: `chain:${b.track}:${b.segment}`, take: `take_${tag}.wav` };
  });
  const script: Job['script'] = [
    ...sections.map((s) => ({ id: `soulx:${s.segment}`, label: `SoulX sings the lead of ${s.segment}`, numbers: { notes: s.notes.length }, files: [`${s.segment}_soulx.wav`] })),
    ...lines.map((x) => ({ id: `harmony:${x.track}:${x.segment}`, label: `Re-pitch the lead of ${x.segment} to ${x.track}`, files: [`${x.tag}_svc.wav`] })),
    ...[...leads, ...lines].map((x) => ({ id: x.chain, label: `Vocal chain on ${x.track} in ${x.segment}`, files: [`${x.tag}_chain.wav`] })),
  ];
  const all = [...leads, ...lines];
  script.push({ id: 'levels', label: 'Set the levels', numbers: Object.fromEntries(lines.map((x) => [`${x.tag}_gain_db`, -9])), files: all.map((x) => x.take) });
  const takes = all.map((x) => ({ segment: x.segment, track: x.track, kind: 'soulx-vocal', file: x.take, durationSeconds: 0.5 }));
  return { script, result: { takes } };
}

/** The transcribe stage (pipeline/transcribe.py run): its steps, and as notes `count` 16ths spread evenly over the
 *  section (start i * section_beats / count on the 16th grid, a 16th long, midi from setTranscribeMidi); with no count, only the
 *  voice. */
function transcribeScript(params: Record<string, unknown>, midiOf: (i: number) => number) {
  const section = String(params['section']);
  const count = params['count'] as number | null;
  const beats = params['section_beats'] as number;
  const script: Job['script'] = [{ id: `recording:${section}`, label: `Read the recording of ${section}`, numbers: { seconds: 2 }, files: [`${section}_recording.wav`] }];
  let voice = `${section}_recording.wav`;
  if (params['has_backing'] === true) {
    voice = `${section}_recording_vocals.wav`;
    script.push({ id: `separate:${section}`, label: `Separate the voice of the recording of ${section}`, files: [voice, `${section}_recording_backing.wav`] });
  }
  let notes: { start: number; duration: number; midi: number }[] | null = null;
  if (count !== null) {
    notes = Array.from({ length: count }, (_, i) => ({ start: Math.floor((i * beats * 4) / count) / 4, duration: 0.25, midi: midiOf(i) }));
    script.push({ id: `transcribe:${section}`, label: `Write down the sung melody of ${section}`, numbers: { notes: count }, files: [`${section}_melody.json`] });
  }
  return { script, result: { section, voice, notes } };
}

/** The add_singer stage (pipeline/add_singer.py run): its steps in order (separate only for a full song), the files
 *  the brain keeps, and add_singer.json. */
function addSingerScript(params: Record<string, unknown>) {
  const script: Job['script'] = [
    { id: 'decode', label: 'Read the recording', numbers: { seconds: 20 }, files: ['recording.wav'] },
    ...(params['separate'] === true ? [{ id: 'separate', label: 'Separate the vocals from the music', files: ['vocals.wav'] }] : []),
    { id: 'silence', label: 'Cut the silences', files: ['voice_cut.wav'] },
    { id: 'reference', label: 'Choose the voice reference', numbers: { startSeconds: 2, endSeconds: 12 }, files: ['voice.wav'] },
    { id: 'pitch', label: "Read the voice reference's pitch" },
    { id: 'words', label: 'Hear the words', files: ['words.json'] },
    { id: 'notes', label: 'Transcribe the notes', files: ['voice.json'] },
    { id: 'test-line', label: 'Sing a test line in the new voice', files: ['test_line.wav'] },
  ];
  const result = {
    audio: 'voice.wav',
    meta: 'voice.json',
    testLine: 'test_line.wav',
    reference: { choice: params['reference'], startSeconds: 2, endSeconds: 12, recordingStartSeconds: 3.5, recordingEndSeconds: 13.5, seconds: 10.1 },
    transcription: 'words',
    heard: 'who says',
    testLinePitch: { notes: 12, within: 11, medianErrorSemitones: 0.2 },
  };
  return { script, result };
}

async function body(req: IncomingMessage): Promise<string> {
  let s = '';
  for await (const chunk of req) s += chunk;
  return s;
}

export async function startFakeVocalsService(): Promise<FakeVocalsService & { server: Server }> {
  const jobs: Job[] = [];
  const cancels: string[] = [];
  const polls: string[] = [];
  const fileFetches: string[] = [];
  const held = new Set<string>();
  let lost = false;
  let transcribeMidi = (i: number) => 60 + (i % 5);
  let n = 0;

  /** One more step of a job (the next scripted one starts running, the running one finishes). */
  const advance = (job: Job) => {
    if (job.state !== 'running') return;
    const now = Date.now() / 1000;
    const running = job.shown.find((s) => s.state === 'running');
    if (running) {
      if (held.has(job.stage)) return;
      const spec = job.script[job.shown.length - 1]!;
      Object.assign(running, { state: 'done', finished: now, text: `${spec.label}: done`, numbers: spec.numbers ?? {}, files: spec.files ?? [] });
    }
    const next = job.script[job.shown.length];
    if (next) job.shown.push({ id: next.id, label: next.label, state: 'running', started: now, finished: null, text: '', numbers: {}, files: [] });
    else job.state = 'done';
  };

  const server = createServer((req, res) => {
    void (async () => {
      const u = new URL(req.url ?? '/', 'http://x');
      const send = (code: number, obj: unknown) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      const jobOf = () => (lost ? undefined : jobs.find((j) => j.id === u.searchParams.get('job')));
      if (req.method === 'POST' && u.pathname === '/generate') {
        const params = JSON.parse(await body(req)) as Record<string, unknown>;
        const stage = String(params['stage']);
        if (stage !== 'sing' && stage !== 'transcribe' && stage !== 'add_singer') return send(400, { error: `unknown stage ${stage}` });
        const { script, result } = stage === 'sing' ? singScript(params) : stage === 'add_singer' ? addSingerScript(params) : transcribeScript(params, transcribeMidi);
        const job: Job = { id: `job${++n}`, stage, params, state: 'running', error: null, script, shown: [], result };
        jobs.push(job);
        return send(202, { job_id: job.id });
      }
      if (req.method === 'GET' && u.pathname === '/result') {
        polls.push(u.searchParams.get('job') ?? '');
        const job = jobOf();
        if (!job) return send(404, { error: 'unknown job' });
        advance(job);
        return send(200, { state: job.state, kind: job.state === 'done' ? 'json' : null, error: job.error, steps: job.shown });
      }
      if (req.method === 'GET' && u.pathname === '/file') {
        const job = jobOf();
        const name = u.searchParams.get('name');
        if (!job) return send(404, { error: 'no file for job' });
        if (name === null) {
          if (job.state !== 'done') return send(404, { error: 'no file for job' });
          return send(200, job.result);
        }
        if (!job.shown.some((s) => s.files.includes(name))) return send(404, { error: `file '${name}' was not listed by any step of this job` });
        fileFetches.push(`${job.id}/${name}`);
        if (name.endsWith('.wav')) {
          res.writeHead(200, { 'content-type': 'audio/wav' });
          return res.end(toneWav());
        }
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end(`${name} of ${job.id}`);
      }
      if (req.method === 'POST' && u.pathname === '/cancel') {
        const job = jobOf();
        if (!job) return send(404, { error: 'unknown job' });
        cancels.push(job.id);
        job.state = 'error';
        job.error = 'Cancelled';
        for (const s of job.shown) if (s.state === 'running') Object.assign(s, { state: 'failed', finished: Date.now() / 1000, text: 'Cancelled' });
        return send(200, { cancelled: true });
      }
      return send(404, { error: 'not found' });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    server,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    jobs,
    cancels,
    polls,
    fileFetches,
    setTranscribeMidi: (fn) => {
      transcribeMidi = fn;
    },
    hold: (stage) => void held.add(stage),
    release: (stage) => void held.delete(stage),
    lose: () => {
      lost = true;
    },
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
