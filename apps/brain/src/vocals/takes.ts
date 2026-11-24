// Sung vocal takes (docs/superpowers/specs/2026-11-24-sung-vocals-design.md §3).
//
// A take is one section's lead vocal sung by SoulX-Singer (svc-soulx): a WAV as long as the section, 44.1 kHz
// stereo 16-bit, the phrases at their times and silence between, loudness-normalised to TAKE_LUFS. It is stored
// as <takesDir>/<fingerprint>.wav (plus <fingerprint>.json: its measured loudness and length) and recorded on the
// song as an `aiArtifacts` entry of kind `soulx-vocal` attached to { segment, instrument: 'Vocal' }, whose
// conditioning.hashes[0] is the fingerprint. A take whose fingerprint is no longer the section's (notes, lyrics,
// voice, tempo, key, settings or take number changed) is stale. Takes are never deleted here (see
// scripts/list-vocal-takes.mjs).

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { AIArtifact, Song } from '@casperaki/song-schema';

import { LEAD_VOCAL, sectionScore, TAKE_SETTINGS, takeFingerprint, type SectionScore } from './score.js';

const execFileAsync = promisify(execFile);

export const TAKE_LUFS = -24;
const TAKE_RATE = 44100;
const FP = /^[0-9a-f]{64}$/u;

export type SectionState = 'none' | 'current' | 'stale' | 'missing';
export interface SectionStatus {
  readonly segment: string;
  readonly state: SectionState;
}

export interface VocalVoice {
  readonly id: string;
  readonly label: string;
  readonly octave: number;
  readonly low: number;
  readonly high: number;
  readonly median: number;
}

/** A request the brain refuses or a service failure, with the HTTP status to answer. */
export class VocalsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface VocalTakesConfig {
  readonly takesDir: string;
  readonly serviceUrl: string;
  readonly ffmpegBin: string;
  readonly fetchImpl?: typeof fetch;
}

/** The song's take (artifact) for a section's lead vocal, if any. */
export function takeArtifact(song: Song, segment: string): AIArtifact | undefined {
  return song.aiArtifacts.find(
    (a) => a.kind === 'soulx-vocal' && a.attachedTo.scope === 'segment' && a.attachedTo.segment === segment && a.attachedTo.instrument === LEAD_VOCAL,
  );
}

/** The fingerprint a take records (conditioning.hashes[0]). */
export function artifactFingerprint(a: AIArtifact): string | undefined {
  return a.conditioning?.hashes?.[0];
}

export class VocalTakes {
  private readonly singing = new Map<string, Promise<void>>();
  private readonly doFetch: typeof fetch;

  constructor(private readonly cfg: VocalTakesConfig) {
    mkdirSync(cfg.takesDir, { recursive: true });
    this.doFetch = cfg.fetchImpl ?? fetch;
  }

  /** The take file of a fingerprint (it may not exist yet). */
  takePath(fingerprint: string): string {
    if (!FP.test(fingerprint)) throw new Error(`not a take fingerprint: ${fingerprint}`);
    return join(this.cfg.takesDir, `${fingerprint}.wav`);
  }

  /** Each section's state for the song's vocals setting. */
  status(song: Song): SectionStatus[] {
    return sectionStates(song, this.cfg.takesDir);
  }

  /** The voices the singing service offers. */
  async voices(): Promise<VocalVoice[]> {
    const body = (await this.call('/voices', {})) as { voices?: VocalVoice[] };
    if (!Array.isArray(body.voices)) throw new VocalsError(502, 'singing_failed', 'The singing service answered /voices without a voice list.');
    return body.voices;
  }

  /** Sings a section (or reuses the stored take with the same fingerprint) and returns its artifact. */
  async sing(song: Song, segment: string): Promise<AIArtifact> {
    const vocals = requireVocals(song);
    if (!song.songStructure.some((s) => s.name === segment)) throw new VocalsError(400, 'invalid_body', `The song has no section "${segment}".`);
    const score = sectionScore(song, segment);
    if (!score) throw new VocalsError(400, 'invalid_body', `Section "${segment}" has no lead vocal notes to sing.`);
    const takeNumber = vocals.takeNumbers[segment] ?? 1;
    const fp = takeFingerprint(score, vocals.voice, takeNumber);
    if (!existsSync(this.takePath(fp))) {
      let job = this.singing.get(fp);
      if (!job) {
        job = this.render(score, vocals.voice, fp).finally(() => this.singing.delete(fp));
        this.singing.set(fp, job);
      }
      await job;
    }
    const info = JSON.parse(readFileSync(join(this.cfg.takesDir, `${fp}.json`), 'utf8')) as { lufs: number; durationSeconds: number };
    return {
      id: `vocal-${segment}-${fp.slice(0, 12)}`,
      kind: 'soulx-vocal',
      modelId: TAKE_SETTINGS.model,
      modelVersion: `steps-${TAKE_SETTINGS.steps}`,
      seed: takeNumber,
      prompt: vocals.voice,
      conditioning: { hashes: [fp] },
      output: { uri: `vocal-take:${fp}.wav`, sha256: sha256File(this.takePath(fp)), lufs: info.lufs, durationSeconds: info.durationSeconds },
      attachedTo: { scope: 'segment', segment, instrument: LEAD_VOCAL },
      createdAt: new Date().toISOString(),
    } as AIArtifact;
  }

  private async render(score: SectionScore, voice: string, fp: string): Promise<void> {
    const body = (await this.call('/sing', {
      voice,
      steps: TAKE_SETTINGS.steps,
      phrases: score.phrases.map((p) => ({ phoneme: p.phoneme, duration: p.duration, notePitch: p.notePitch, noteType: p.noteType })),
    })) as { sampleRate?: number; phrases?: { wav?: string }[] };
    const rate = body.sampleRate;
    if (typeof rate !== 'number' || !Array.isArray(body.phrases) || body.phrases.length !== score.phrases.length) {
      throw new VocalsError(502, 'singing_failed', `The singing service answered with ${body.phrases?.length ?? 'no'} phrases for ${score.phrases.length}.`);
    }
    // Place the phrases on the section's timeline (mono, the service's rate).
    const total = Math.round(score.lengthSec * rate);
    const mix = new Float32Array(total);
    body.phrases.forEach((p, i) => {
      if (typeof p.wav !== 'string') throw new VocalsError(502, 'singing_failed', `The singing service answered phrase ${i} without audio.`);
      const pcm = readPcm16Mono(Buffer.from(p.wav, 'base64'), rate, i);
      const at = Math.round(score.phrases[i]!.startSec * rate);
      for (let k = 0; k < pcm.length && at + k < total; k++) mix[at + k]! += pcm[k]!;
    });
    const tmpDir = join(this.cfg.takesDir, `.tmp-${fp}-${process.pid}`);
    mkdirSync(tmpDir, { recursive: true });
    try {
      const raw = join(tmpDir, 'raw.wav');
      writeFileSync(raw, wav16Mono(mix, rate));
      const out = join(tmpDir, 'take.wav');
      // 44.1 kHz stereo, normalised to TAKE_LUFS, exactly the section's length.
      await execFileAsync(this.cfg.ffmpegBin, [
        '-hide_banner', '-nostdin', '-y', '-i', raw,
        '-af', `loudnorm=I=${TAKE_LUFS}:TP=-2:LRA=11,aresample=${TAKE_RATE},apad`,
        '-t', score.lengthSec.toFixed(6), '-ac', '2', '-ar', String(TAKE_RATE), '-c:a', 'pcm_s16le', out,
      ]);
      const lufs = await this.measureLufs(out);
      writeFileSync(join(tmpDir, 'take.json'), JSON.stringify({ lufs, durationSeconds: Math.round(score.lengthSec * 1e6) / 1e6, voice, settings: TAKE_SETTINGS }));
      renameSync(join(tmpDir, 'take.json'), join(this.cfg.takesDir, `${fp}.json`));
      renameSync(out, this.takePath(fp));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  private async measureLufs(file: string): Promise<number> {
    const { stderr } = await execFileAsync(this.cfg.ffmpegBin, ['-hide_banner', '-nostdin', '-i', file, '-af', 'ebur128', '-f', 'null', '-']);
    const m = /Integrated loudness:\s*I:\s*(-?[\d.]+) LUFS/u.exec(stderr);
    if (!m) throw new Error(`could not measure the loudness of ${file}`);
    return Number(m[1]);
  }

  private async call(path: string, payload: unknown): Promise<unknown> {
    const url = `${this.cfg.serviceUrl.replace(/\/$/u, '')}${path}`;
    let res: Response;
    try {
      res = await this.doFetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    } catch (err) {
      throw new VocalsError(502, 'singing_unreachable', `The singing service could not be reached (${url}): ${err instanceof Error ? err.message : String(err)}`);
    }
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new VocalsError(502, 'singing_failed', `The singing service answered ${res.status} with something that is not JSON: ${text.slice(0, 200)}`);
    }
    if (!res.ok) {
      const msg = String((body as { error?: unknown }).error ?? text.slice(0, 200));
      throw new VocalsError(res.status < 500 ? 422 : 502, 'singing_failed', `The singing service refused: ${msg}`);
    }
    return body;
  }
}

/** Each section's take state (none | current | stale | missing) for the song's vocals setting. */
export function sectionStates(song: Song, takesDir: string): SectionStatus[] {
  const vocals = requireVocals(song);
  return song.songStructure.map((seg): SectionStatus => {
    const score = sectionScore(song, seg.name);
    if (!score) return { segment: seg.name, state: 'none' };
    const fp = takeFingerprint(score, vocals.voice, vocals.takeNumbers[seg.name] ?? 1);
    const a = takeArtifact(song, seg.name);
    if (!a) return { segment: seg.name, state: 'missing' };
    if (artifactFingerprint(a) !== fp) return { segment: seg.name, state: 'stale' };
    return { segment: seg.name, state: existsSync(join(takesDir, `${fp}.wav`)) ? 'current' : 'missing' };
  });
}

function requireVocals(song: Song): NonNullable<Song['vocals']> {
  if (!song.vocals) throw new VocalsError(400, 'vocals_off', 'The song has no vocals setting (Vocals is off).');
  return song.vocals;
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** 16-bit mono PCM of a WAV file as floats; the rate must be `rate`. */
export function readPcm16Mono(buf: Buffer, rate: number, phrase: number): Float32Array {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new VocalsError(502, 'singing_failed', `phrase ${phrase}: the audio is not a WAV file`);
  let off = 12;
  let fmt: { channels: number; rate: number; bits: number } | undefined;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { channels: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    if (id === 'data') {
      if (!fmt || fmt.channels !== 1 || fmt.bits !== 16 || fmt.rate !== rate) {
        throw new VocalsError(502, 'singing_failed', `phrase ${phrase}: expected 16-bit mono at ${rate} Hz, got ${JSON.stringify(fmt)}`);
      }
      const n = Math.floor(Math.min(size, buf.length - off - 8) / 2);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(off + 8 + i * 2) / 32768;
      return out;
    }
    off += 8 + size + (size % 2);
  }
  throw new VocalsError(502, 'singing_failed', `phrase ${phrase}: the WAV has no data`);
}

/** A 16-bit mono WAV of the samples (clipped to ±1). */
export function wav16Mono(samples: Float32Array, rate: number): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i]!)) * 32767), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
