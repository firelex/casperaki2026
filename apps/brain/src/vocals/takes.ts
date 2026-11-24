// Sung vocal takes (docs/superpowers/specs/2026-11-24-sung-vocals-design.md §3, revised 2026-11-24: takes are
// looked up by fingerprint, not recorded on the song).
//
// A take is one section's lead vocal sung by SoulX-Singer (svc-soulx): an OGG as long as the section, 44.1 kHz
// stereo, the phrases at their times and silence between, at TAKE_LUFS. It is stored as <takesDir>/<fingerprint>.ogg
// (plus <fingerprint>.json: loudness, length, checksum). The fingerprint is what the take was sung from (the
// section's notes and lyrics in seconds, the voice, the settings, the take number), so whenever a song is loaded
// (play, export, render) its sections' takes are found by computing their fingerprints: a section with a stored
// take plays it, one without plays no vocal (greyed in the editor). Nothing is written into the song.
//
// Clean-up: when a saved song is replaced (saved again) or deleted, the takes its old version used that no saved
// song uses any more are deleted (deleteUnusedTakes).

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { AIArtifact, Song } from '@casperaki/song-schema';

import { LEAD_VOCAL, sectionScore, TAKE_SETTINGS, takeFingerprint, type SectionScore } from './score.js';

const execFileAsync = promisify(execFile);

/** Loudness of a take: about 3 dB under the band once mixed (the lane plays at 0 dB; the library's -24 LUFS left the vocal ~10 dB under the band). */
export const TAKE_LUFS = -17;
/** Backing vocal takes: 6 dB under the lead. */
export const TAKE_LUFS_BACKING = -23;
/** Highest peak a take may have (dBFS); a take whose loudness gain would push it higher is left quieter. */
const TAKE_PEAK_DB = -1;
const TAKE_RATE = 44100;
const FP = /^[0-9a-f]{64}$/u;

/** none: no lead vocal notes; sung: a stored take matches the section as it is; unsung: no such take. */
export type SectionState = 'none' | 'sung' | 'unsung';
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
    return join(this.cfg.takesDir, `${fingerprint}.ogg`);
  }

  /** Every sung vocal track's sections: sung (a stored take matches it), unsung, or none (no notes there). */
  status(song: Song): Record<string, SectionStatus[]> {
    return songStates(song, this.cfg.takesDir);
  }

  /** The voices the singing service offers. */
  async voices(): Promise<VocalVoice[]> {
    const body = (await this.call('/voices', {})) as { voices?: VocalVoice[] };
    if (!Array.isArray(body.voices)) throw new VocalsError(502, 'singing_failed', 'The singing service answered /voices without a voice list.');
    return body.voices;
  }

  /** Sings a section of a vocal track (nothing to do when a take with its fingerprint is stored). */
  async sing(song: Song, segment: string, track: string): Promise<SectionStatus> {
    const setting = requireSetting(song, track);
    if (!song.songStructure.some((s) => s.name === segment)) throw new VocalsError(400, 'invalid_body', `The song has no section "${segment}".`);
    const score = sectionScore(song, segment, track);
    if (!score) throw new VocalsError(400, 'invalid_body', `Section "${segment}" has no notes on "${track}" to sing.`);
    const role = roleOf(track);
    const fp = takeFingerprint(score, setting.voice, setting.takeNumbers[segment] ?? 1, role);
    if (!existsSync(this.takePath(fp))) {
      let job = this.singing.get(fp);
      if (!job) {
        job = this.render(score, setting.voice, fp, role === 'backing' ? TAKE_LUFS_BACKING : TAKE_LUFS).finally(() => this.singing.delete(fp));
        this.singing.set(fp, job);
      }
      await job;
    }
    return { segment, state: 'sung' };
  }

  private async render(score: SectionScore, voice: string, fp: string, lufsTarget: number): Promise<void> {
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
      // One fixed gain to TAKE_LUFS (no dynamic loudness filter: it can drop or shift samples, and the phrases must
      // stay on the beat), held so the peak stays at or below TAKE_PEAK_DB.
      const rawLufs = await this.measureLufs(raw);
      let peak = 0;
      for (const x of mix) peak = Math.max(peak, Math.abs(x));
      if (!Number.isFinite(rawLufs) || peak === 0) throw new VocalsError(502, 'singing_failed', 'The singing service returned silence.');
      const gainDb = Math.min(lufsTarget - rawLufs, TAKE_PEAK_DB - 20 * Math.log10(peak));
      const out = join(tmpDir, 'take.ogg');
      // 44.1 kHz stereo, exactly the section's length, Ogg Vorbis (about a tenth of a WAV, as the sample library).
      await execFileAsync(this.cfg.ffmpegBin, [
        '-hide_banner', '-nostdin', '-y', '-i', raw,
        '-af', `volume=${gainDb.toFixed(3)}dB,aresample=${TAKE_RATE},apad`,
        '-t', score.lengthSec.toFixed(6), '-ac', '2', '-ar', String(TAKE_RATE), '-c:a', 'libvorbis', '-q:a', '6', out,
      ]);
      const lufs = await this.measureLufs(out);
      writeFileSync(join(tmpDir, 'take.json'), JSON.stringify({ lufs, durationSeconds: Math.round(score.lengthSec * 1e6) / 1e6, sha256: sha256File(out), voice, settings: TAKE_SETTINGS }));
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

/** The song's sung vocal tracks: the lead ("Vocal", setting `vocals`) and each backing track with a setting
 *  (`backingVocals`, by track name). */
export function vocalTracks(song: Song): { track: string; setting: NonNullable<Song['vocals']> }[] {
  return [
    ...(song.vocals ? [{ track: LEAD_VOCAL, setting: song.vocals }] : []),
    ...Object.entries(song.backingVocals ?? {}).map(([track, setting]) => ({ track, setting })),
  ];
}

const roleOf = (track: string): 'lead' | 'backing' => (track === LEAD_VOCAL ? 'lead' : 'backing');

/** Each section's fingerprint on a vocal track as the song is now (undefined: no notes there, or the track has no
 *  setting, so nothing was ever sung for it). */
export function sectionFingerprints(song: Song, track: string): { segment: string; fp: string | undefined; hasNotes: boolean }[] {
  const setting = vocalTracks(song).find((t) => t.track === track)?.setting;
  return song.songStructure.map((seg) => {
    const score = sectionScore(song, seg.name, track);
    if (!score) return { segment: seg.name, fp: undefined, hasNotes: false };
    if (!setting) return { segment: seg.name, fp: undefined, hasNotes: true };
    return { segment: seg.name, fp: takeFingerprint(score, setting.voice, setting.takeNumbers[seg.name] ?? 1, roleOf(track)), hasNotes: true };
  });
}

/** Each section's state on a vocal track: sung (a stored take matches it), unsung, or none (no notes there). */
export function sectionStates(song: Song, takesDir: string, track: string): SectionStatus[] {
  return sectionFingerprints(song, track).map(({ segment, fp, hasNotes }): SectionStatus => ({
    segment,
    state: !hasNotes ? 'none' : fp && existsSync(join(takesDir, `${fp}.ogg`)) ? 'sung' : 'unsung',
  }));
}

/** The states of every sung vocal track of the song (tracks with a setting), by track name. */
export function songStates(song: Song, takesDir: string): Record<string, SectionStatus[]> {
  return Object.fromEntries(vocalTracks(song).map(({ track }) => [track, sectionStates(song, takesDir, track)]));
}

/** The song as the engine gets it: its vocal takes (soulx-vocal artifacts) are the stored takes that match its
 *  sections now, on every sung vocal track; any take recorded on the song itself is ignored. */
export function withStoredTakes(song: Song, takesDir: string): Song {
  const takes: AIArtifact[] = [];
  for (const { track } of vocalTracks(song)) {
    for (const { segment, fp } of sectionFingerprints(song, track)) {
      if (!fp || !existsSync(join(takesDir, `${fp}.ogg`))) continue;
      const info = JSON.parse(readFileSync(join(takesDir, `${fp}.json`), 'utf8')) as { lufs: number; durationSeconds: number; sha256: string; voice: string };
      takes.push({
        id: `vocal-${track}-${segment}-${fp.slice(0, 12)}`,
        kind: 'soulx-vocal',
        modelId: TAKE_SETTINGS.model,
        modelVersion: `steps-${TAKE_SETTINGS.steps}`,
        prompt: info.voice,
        conditioning: { hashes: [fp] },
        output: { uri: `vocal-take:${fp}.ogg`, sha256: info.sha256, lufs: info.lufs, durationSeconds: info.durationSeconds },
        attachedTo: { scope: 'segment', segment, instrument: track },
      } as AIArtifact);
    }
  }
  return { ...song, aiArtifacts: [...song.aiArtifacts.filter((a) => a.kind !== 'soulx-vocal'), ...takes] };
}

/** The fingerprints of the takes a song plays (every sung vocal track, its sections as they are). */
export function songTakeFingerprints(song: Song): Set<string> {
  return new Set(vocalTracks(song).flatMap(({ track }) => sectionFingerprints(song, track).flatMap((s) => (s.fp ? [s.fp] : []))));
}

/** Deletes the takes among `candidates` that are not in `used` (files .ogg and .json). Returns the deleted ones. */
export function deleteUnusedTakes(takesDir: string, candidates: Iterable<string>, used: ReadonlySet<string>): string[] {
  const deleted: string[] = [];
  for (const fp of candidates) {
    if (used.has(fp) || !FP.test(fp)) continue;
    let any = false;
    for (const ext of ['ogg', 'json']) {
      const f = join(takesDir, `${fp}.${ext}`);
      if (existsSync(f)) {
        rmSync(f);
        any = true;
      }
    }
    if (any) deleted.push(fp);
  }
  return deleted;
}

function requireSetting(song: Song, track: string): NonNullable<Song['vocals']> {
  const setting = vocalTracks(song).find((t) => t.track === track)?.setting;
  if (!setting) throw new VocalsError(400, 'vocals_off', `The song has no singing setting for "${track}" (no voice chosen).`);
  return setting;
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
