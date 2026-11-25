// An in-process stand-in for the vocals service (svc-vocals on the serving harness): the harness's job contract
// (POST /generate, GET /result, GET /file, POST /cancel; an unknown job answers 404 {"error": "unknown job"}) with
// scripted stages. Each poll of /result finishes one more step; a held stage stays on its first step until released.
// Steps and their files are named as pipeline/lead.py and pipeline/repeats.py name them (3 seeds per YuE2 unit, each
// seed's take listing the unit's shared score and lyrics). The lead stage "sings" each unit exactly as written (its melody is the unit's notes with their words), so copies
// follow their unit note for note; the repeats stage makes one take per copy, backing line, extension and the ad-libs.

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

type Unit = { id: string; notes: { start: number; duration: number; midi: number }[]; words: string[][]; phonemes: string[][][] };

const SEEDS = [1, 2, 3];

/** The yue2 / separate / chords steps of some units, named and listing files as pipeline/lead.py does (the unit's
 *  score and lyrics listed by every seed's take). */
function takeSteps(units: readonly string[], id: (phase: string, uid: string, seed: number) => string): Job['script'] {
  return [
    ...units.flatMap((u) => SEEDS.map((n) => ({ id: id('yue2', u, n), label: `Sing ${u} (take ${n})`, files: [`${u}_s${n}.wav`, `${u}.abc`, `${u}_lyrics.txt`] }))),
    ...units.flatMap((u) => SEEDS.map((n) => ({ id: id('separate', u, n), label: `Separate the voice of ${u} (take ${n})`, files: [`${u}_s${n}_vocals.wav`, `${u}_s${n}_backing.wav`] }))),
    ...units.flatMap((u) => SEEDS.map((n) => ({ id: id('chords', u, n), label: `Check the chords of ${u} (take ${n})`, numbers: { chords_match: 0.9 }, files: [`${u}_s${n}_chords.json`] }))),
  ];
}

function leadScript(params: Record<string, unknown>) {
  const units = params['units'] as Unit[];
  const script: Job['script'] = [
    ...takeSteps(units.map((u) => u.id), (phase, uid, seed) => `${phase}:${uid}:s${seed}`),
    ...units.flatMap((u) => [
      // the transcription lists the separated vocal the separate step listed already
      { id: `transcribe:${u.id}:s1`, label: `Write down the sung melody of ${u.id} (take 1)`, numbers: { notes: u.notes.length }, files: [`${u.id}_s1_vocals.wav`] },
      { id: `choose:${u.id}`, label: `Choose the take of ${u.id}`, numbers: { seed: 1, chords_match: 0.9, notes: u.notes.length }, files: [`${u.id}_section.wav`, `${u.id}_melody.json`] },
    ]),
  ];
  const result = {
    units: Object.fromEntries(
      units.map((u) => {
        const words = u.words.flat();
        const phonemes = u.phonemes.flat();
        const melody = u.notes.map((n, i) => ({ ...n, word: words[i], phonemes: phonemes[i] }));
        return [u.id, { take: `${u.id}_section.wav`, seed: 1, chords_match: 0.9, melody }];
      }),
    ),
  };
  return { script, result };
}

/** The repeats stage's steps in pipeline/repeats.py's order and file names. */
function repeatsScript(params: Record<string, unknown>) {
  const copies = params['copies'] as { segment: string }[];
  const backings = params['backings'] as { segment: string; track: string }[];
  const extensions = params['extensions'] as { segment: string }[];
  const adlibs = params['adlibs'] as { segments: string[]; chorus_unit: string } | null;
  const takes: { segment: string; track: string; kind: string; file: string; durationSeconds: number }[] = [];
  const sung = [
    ...copies.map((c) => ({ segment: c.segment, track: 'Vocal', tag: c.segment, sing: `soulx:${c.segment}`, svc: `svc:${c.segment}`, chain: `chain:${c.segment}`, take: `take_${c.segment}_vocal.wav` })),
    ...backings.map((b) => {
      const tag = `${b.segment}_${slug(b.track)}`;
      return { segment: b.segment, track: b.track, tag, sing: `backing:${b.track}:${b.segment}`, svc: `svc:${b.track}:${b.segment}`, chain: `chain:${b.track}:${b.segment}`, take: `take_${tag}.wav` };
    }),
  ];
  const script: Job['script'] = [
    ...sung.map((x) => ({ id: x.sing, label: `SoulX sings ${x.track} in ${x.segment}`, files: [`${x.tag}_soulx.wav`] })),
    ...sung.map((x) => ({ id: x.svc, label: `Convert ${x.track} in ${x.segment}`, files: [`${x.tag}_svc.wav`] })),
  ];
  if (adlibs) {
    const uid = `${adlibs.chorus_unit}_adlibs`;
    script.push(...takeSteps([uid], (phase, _u, seed) => `adlibs:${phase}:s${seed}`));
    script.push({ id: 'adlibs:choose', label: 'Choose the ad-lib take', numbers: { seed: 1, chords_match: 0.9 }, files: ['adlibs_section.wav'] });
  }
  script.push(...sung.map((x) => ({ id: x.chain, label: `Vocal chain on ${x.track} in ${x.segment}`, files: [`${x.tag}_chain.wav`] })));
  for (const e of extensions) {
    script.push({ id: `extension:${e.segment}`, label: `Join the extra bars of ${e.segment}`, files: [`take_${e.segment}_ext.wav`] });
    takes.push({ segment: e.segment, track: 'Vocal', kind: 'yue2-vocal', file: `take_${e.segment}_ext.wav`, durationSeconds: 0.5 });
  }
  if (adlibs) script.push({ id: 'adlibs:gate', label: 'Keep the ad-libs in the gaps of the chorus', files: ['adlibs_gated.wav'] });
  const levelled = sung.map((x) => x.take);
  for (const x of sung) takes.push({ segment: x.segment, track: x.track, kind: 'soulx-vocal', file: x.take, durationSeconds: 0.5 });
  if (adlibs) {
    levelled.push('take_adlibs.wav');
    for (const seg of adlibs.segments) takes.push({ segment: seg, track: 'Ad-libs', kind: 'yue2-vocal', file: 'take_adlibs.wav', durationSeconds: 0.5 });
  }
  script.push({ id: 'levels', label: 'Set the levels', numbers: Object.fromEntries(levelled.map((f) => [`${f}_gain_db`, -6])), files: levelled });
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
        const { script, result } = stage === 'lead' ? leadScript(params) : stage === 'transcribe' ? transcribeScript(params, transcribeMidi) : repeatsScript(params);
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
