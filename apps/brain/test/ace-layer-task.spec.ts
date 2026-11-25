// The ACE layer task (docs/superpowers/specs/2026-11-25-ace-layer-design.md) against a fake ace service: the render is
// handed to the service with the song's caption, bpm and key; the part comes back cut into one stored clip per covered
// section (with a selection: silent outside the selected bars); the service's steps sit between the brain's own.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyAceLayer, orchestrate } from '@casperaki/arrangement';
import { vocalTakeFingerprint } from '@casperaki/song-schema';

import { aceCaption, coveredSections, keyScale, runAceLayer, type AceLayerOptions } from '../src/ace/aceLayerTask.js';
import type { ServiceResult, VocalsClient } from '../src/sing/vocalsClient.js';
import type { TaskJobs, TaskStep } from '../src/store.js';
import { toneWav } from './fakeVocalsService.js';

const SONG = orchestrate({ genre: 'brightPop', key: 'Am', bpm: 120, seed: 'ace-layer' });
const SEC_PER_BAR = 2; // 4 beats at 120 bpm
const songSeconds = SONG.songStructure.reduce((n, s) => n + s.bars.length, 0) * SEC_PER_BAR;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ace-layer-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A fake ace service: one job that reports a "lego" step, then returns a tone as long as the song. */
function fakeClient() {
  const submitted: Record<string, unknown>[] = [];
  const client = {
    submit: async (params: Record<string, unknown>) => {
      submitted.push(params);
      return 'job1';
    },
    result: async (): Promise<ServiceResult> => ({
      state: 'done',
      error: null,
      steps: [{ id: 'lego', label: 'Play the guitar part over the song', state: 'done', started: 1_700_000_000, finished: 1_700_000_003, text: '3 s', numbers: {}, files: [] }],
    }) as ServiceResult,
    file: async () => toneWav(songSeconds),
    cancel: async () => true,
  };
  return { client: client as unknown as VocalsClient, submitted };
}

async function run(options: AceLayerOptions) {
  const { client, submitted } = fakeClient();
  const render = join(dir, 'render.wav');
  writeFileSync(render, toneWav(songSeconds));
  let steps: TaskStep[] = [];
  let jobs: TaskJobs | null = null;
  const result = await runAceLayer({
    taskId: 't1',
    input: SONG,
    options,
    client,
    filesDir: join(dir, 'files', 't1'),
    takesDir: join(dir, 'takes'),
    ffmpegBin: 'ffmpeg',
    pollMs: 1,
    signal: new AbortController().signal,
    jobs: null,
    setJobs: (j) => (jobs = j),
    setSteps: (s) => (steps = s),
    now: () => new Date().toISOString(),
    renderWav: async () => render,
  });
  return { result, submitted, steps, jobs };
}

const seconds = (path: string) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path]).toString());
/** The loudest sample of a stretch of an OGG clip, in dB (-Infinity = silent). */
const peakDb = (path: string, from: number, to: number) => {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-ss', String(from), '-t', String(to - from), '-i', path, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = /max_volume: (-?[\d.]+|-inf) dB/u.exec(r.stderr);
  if (!m) throw new Error(`no max_volume in ffmpeg's output: ${r.stderr}`);
  return m[1] === '-inf' ? -Infinity : Number(m[1]);
};

describe('the ACE layer task', () => {
  it('asks the service for the part with the caption, bpm and key, and stores one clip per section', async () => {
    const options: AceLayerOptions = { instrument: 'guitar', words: 'bright, funky', seed: 5 };
    const { result, submitted, steps, jobs } = await run(options);
    expect(submitted).toEqual([
      { src_wav: join(dir, 'render.wav'), track: 'guitar', caption: aceCaption(SONG, options), bpm: 120, key_scale: 'A minor', seed: 5 },
    ]);
    expect(aceCaption(SONG, options)).toMatch(/bright, funky, 120 bpm, A minor$/u);
    expect(jobs).toEqual({ ace: 'job1' });
    expect(steps.map((s) => [s.id.replace(/^ace\./u, ''), s.state])).toEqual([
      ['render', 'done'],
      ['lego', 'done'],
      ['clips', 'done'],
    ]);
    expect(result.track).toBe('ACE Guitar');
    expect(result.takes.map((t) => t.segment)).toEqual(SONG.songStructure.map((s) => s.name));
    for (const [i, t] of result.takes.entries()) {
      const path = join(dir, 'takes', `${t.sha256}.ogg`);
      expect(existsSync(path)).toBe(true);
      expect(t.durationSeconds).toBe(SONG.songStructure[i]!.bars.length * SEC_PER_BAR);
      expect(seconds(path)).toBeCloseTo(t.durationSeconds, 1);
      expect(t.fingerprint).toBe(vocalTakeFingerprint(SONG, t.segment, 'ACE Guitar'));
    }
    expect(existsSync(join(dir, 'files', 't1', 'ace', 'layer.wav'))).toBe(true);
    // The result goes into the song.
    const song = applyAceLayer(SONG, result);
    expect(song.aiArtifacts.filter((a) => a.kind === 'ace-step-conditioned')).toHaveLength(SONG.songStructure.length);
  });

  it('with a selection: only the sections it touches, silent outside the selected bars', async () => {
    const second = coveredSections(SONG, undefined)[1]!;
    // From the middle of the second section to its end.
    const startBar = second.startBar + second.bars / 2;
    const range = { startBar, endBar: second.startBar + second.bars };
    const { result } = await run({ instrument: 'strings', range, seed: 1 });
    expect(result.takes.map((t) => t.segment)).toEqual([second.name]);
    const path = join(dir, 'takes', `${result.takes[0]!.sha256}.ogg`);
    expect(seconds(path)).toBeCloseTo(second.bars * SEC_PER_BAR, 1);
    const half = (second.bars / 2) * SEC_PER_BAR;
    expect(peakDb(path, 0.1, half - 0.1)).toBeLessThan(-80);
    expect(peakDb(path, half + 0.1, 2 * half - 0.1)).toBeGreaterThan(-30);
  });

  it('refuses a selection outside the song and a key ACE does not know', () => {
    expect(() => coveredSections(SONG, { startBar: 10_000, endBar: 10_004 })).toThrow(/outside the song/u);
    expect(() => keyScale('H')).toThrow(/not a key ACE understands/u);
    expect(keyScale('F#m')).toBe('F# minor');
  });
});
