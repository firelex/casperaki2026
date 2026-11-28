// A fake speech service (apps/models/services/speech, harness contract) for the brain's tests: the speaking_voice
// stage's steps (one per candidate seed, then the match) finish one per poll; the closest candidate is `best` (default
// the second seed); `fail(message)` makes the next job fail.

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { toneWav } from './fakeVocalsService.js';

interface Step { id: string; label: string; state: string; started: number; finished: number | null; text: string; numbers: Record<string, number>; files: string[] }
interface Job { id: string; params: Record<string, unknown>; script: Omit<Step, 'state' | 'started' | 'finished'>[]; shown: Step[]; state: string; error: string | null; result: unknown; failWith?: string }

export interface FakeSpeechService {
  url: string;
  jobs: Job[];
  /** The seed the match step chooses (default: the second seed asked for). */
  best?: number;
  /** A seed whose score the result leaves out (a broken service). */
  dropScore?: number;
  fail(message: string): void;
  /** Keeps new jobs on their first step until `release`. */
  hold(): void;
  release(): void;
  stop(): Promise<void>;
}

async function body(req: IncomingMessage): Promise<string> {
  let s = '';
  for await (const chunk of req) s += chunk;
  return s;
}

export async function startFakeSpeechService(): Promise<FakeSpeechService & { server: Server }> {
  const jobs: Job[] = [];
  let failNext: string | undefined;
  let held = false;
  let n = 0;
  const svc: FakeSpeechService & { server?: Server } = {
    url: '',
    jobs,
    fail: (m) => void (failNext = m),
    hold: () => void (held = true),
    release: () => void (held = false),
    stop: () => new Promise<void>((resolve) => svc.server!.close(() => resolve())),
  };
  const advance = (job: Job) => {
    if (job.state !== 'running') return;
    if (held && job.shown.length >= 1) return;
    const next = job.script[job.shown.length];
    if (job.failWith && job.shown.length === 1) {
      job.state = 'error';
      job.error = job.failWith;
      return;
    }
    if (!next) {
      job.state = 'done';
      return;
    }
    job.shown.push({ ...next, state: 'done', started: Date.now() / 1000, finished: Date.now() / 1000 });
  };
  const server = createServer((req, res) => {
    const send = (code: number, obj: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    void (async () => {
      const u = new URL(req.url ?? '/', 'http://x');
      const jobOf = () => jobs.find((j) => j.id === u.searchParams.get('job'));
      if (req.method === 'GET' && u.pathname === '/health') return send(200, { ready: true });
      if (req.method === 'POST' && u.pathname === '/generate') {
        const params = JSON.parse(await body(req)) as Record<string, unknown>;
        if (params['stage'] === 'lines') {
          // The lines stage: one step per line, its WAV (one second of tone per 3 words, at least 1 s).
          const lines = params['lines'] as { id: string; text: string }[];
          const seconds = (t: string) => Math.max(1, t.split(/\s+/u).length / 3);
          const job: Job = {
            id: `speech${++n}`,
            params,
            script: lines.map((l) => ({ id: l.id, label: l.text.slice(0, 60), text: `${seconds(l.text).toFixed(1)} s`, numbers: { seconds: seconds(l.text) }, files: [`${l.id}.wav`] })),
            shown: [],
            state: 'running',
            error: null,
            result: { lines: lines.map((l) => ({ id: l.id, file: `${l.id}.wav`, seconds: seconds(l.text) })) },
            ...(failNext ? { failWith: failNext } : {}),
          };
          failNext = undefined;
          jobs.push(job);
          return send(202, { job_id: job.id });
        }
        if (params['stage'] !== 'speaking_voice') return send(400, { error: `unknown stage ${String(params['stage'])}` });
        const seeds = params['seeds'] as number[];
        const best = svc.best ?? seeds[Math.min(1, seeds.length - 1)]!;
        const matched = params['match'] === true;
        const scores = Object.fromEntries(seeds.filter((s) => s !== svc.dropScore).map((s) => [String(s), s === best ? 0.9 : 0.5]));
        const job: Job = {
          id: `speech${++n}`,
          params,
          script: [
            ...seeds.map((s) => ({ id: `speak-${s}`, label: `candidate voice ${s}`, text: '2.0 s', numbers: { seconds: 2 }, files: [`candidate-${s}.wav`] })),
            ...(matched ? [{ id: 'match', label: 'closest to the singing voice', text: `seed ${best}`, numbers: {}, files: [`candidate-${best}.wav`] }] : []),
          ],
          shown: [],
          state: 'running',
          error: null,
          result: matched ? { best_seed: best, scores, sample: `candidate-${best}.wav` } : { best_seed: seeds[0], scores: {}, sample: `candidate-${seeds[0]}.wav` },
          ...(failNext ? { failWith: failNext } : {}),
        };
        failNext = undefined;
        jobs.push(job);
        return send(202, { job_id: job.id });
      }
      if (req.method === 'GET' && u.pathname === '/result') {
        const job = jobOf();
        if (!job) return send(404, { error: 'unknown job' });
        advance(job);
        return send(200, { state: job.state, kind: job.state === 'done' ? 'json' : null, error: job.error, steps: job.shown });
      }
      if (req.method === 'GET' && u.pathname === '/file') {
        const job = jobOf();
        const name = u.searchParams.get('name');
        if (!job) return send(404, { error: 'no file for job' });
        if (name === null) return job.state === 'done' ? send(200, job.result) : send(404, { error: 'not done' });
        if (!job.shown.some((s) => s.files.includes(name))) return send(404, { error: `file '${name}' was not listed` });
        res.writeHead(200, { 'content-type': 'audio/wav' });
        const lineSeconds = (job.result as { lines?: { file: string; seconds: number }[] }).lines?.find((l) => l.file === name)?.seconds;
        return res.end(toneWav(lineSeconds ?? 0.5));
      }
      if (req.method === 'POST' && u.pathname === '/cancel') return send(200, { cancelled: true });
      return send(404, { error: 'not found' });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  svc.server = server;
  svc.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return svc as FakeSpeechService & { server: Server };
}
