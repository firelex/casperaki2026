// The ACE layer task (docs/superpowers/specs/2026-11-25-ace-layer-design.md) against a fake ace service: the render is
// handed to the service with the song's caption, bpm and key; the part comes back cut into one stored clip per covered
// section (with a selection: silent outside the selected bars); the service's steps sit between the brain's own.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyAceLayer, orchestrate } from '@casperaki/arrangement';
import { finalChoruses, rapLineCount, vocalTakeFingerprint, type Song } from '@casperaki/song-schema';


import { ACE_LAYER_LUFS, RAP_TAKES, aceCaption, aceLyrics, AceLayerOptionsSchema, coveredSections, keyScale, runAceLayer, sectionKind, type AceLayerOptions } from '../src/ace/aceLayerTask.js';
import { integratedLoudness } from '../src/audio/loudness.js';
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

async function run(options: AceLayerOptions, extra: Partial<Parameters<typeof runAceLayer>[0]> = {}) {
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
    ...extra,
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
    // Levelled to the library's -24 LUFS (the fake part is a tone at about -23 LUFS, the same in every section).
    const clip = join(dir, 'takes', `${result.takes[0]!.sha256}.ogg`);
    expect(await integratedLoudness('ffmpeg', clip)).toBeCloseTo(ACE_LAYER_LUFS, 0);
    expect(steps.find((s) => s.id === 'clips')!.numbers!['gainDb']).toBeCloseTo(ACE_LAYER_LUFS - (await integratedLoudness('ffmpeg', join(dir, 'files', 't1', 'ace', 'layer.wav'))), 1);
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

  it('with section kinds: clips only in sections of those kinds (ACE still plays the whole song)', async () => {
    const choruses = SONG.songStructure.filter((s) => sectionKind(s.name) === 'chorus').map((s) => s.name);
    expect(choruses.length).toBeGreaterThan(0);
    const { result, submitted } = await run({ instrument: 'brass', sectionKinds: ['chorus'], seed: 2 });
    expect(result.takes.map((t) => t.segment)).toEqual(choruses);
    expect(submitted).toHaveLength(1);
    expect(() => coveredSections(SONG, undefined, ['solo'])).toThrow(/no section of the kind "solo"/u);
    expect(sectionKind('preChorus2')).toBe('preChorus');
  });

  it('ad-libs: sung on the chosen voice with the words under every chorus, kept only in the final chorus(es)', async () => {
    const names = SONG.songStructure.map((s) => s.name);
    const finals = finalChoruses(names);
    expect(finals.length).toBeGreaterThan(0);
    const { result, submitted } = await run({ instrument: 'adlibs', lyrics: '(oh yeah)\n(hey!)', voice: 'backing_vocals', sections: finals, seed: 4 });
    expect(submitted[0]).toMatchObject({ track: 'backing_vocals', lyrics: aceLyrics(SONG, '(oh yeah)\n(hey!)') });
    const lyrics = String(submitted[0]!['lyrics']);
    expect(lyrics.split('\n\n')).toHaveLength(names.length);
    expect(lyrics.match(/\[Chorus\]\n\(oh yeah\)\n\(hey!\)/gu)?.length).toBe(names.filter((n) => sectionKind(n) === 'chorus').length);
    expect(result.track).toBe('ACE Ad-libs');
    expect(result.takes.map((t) => t.segment)).toEqual(finals);
  });

  it('only ad-libs take words and a voice, and ad-libs need both', () => {
    expect(AceLayerOptionsSchema.safeParse({ instrument: 'guitar', lyrics: 'la', seed: 1 }).success).toBe(false);
    expect(AceLayerOptionsSchema.safeParse({ instrument: 'adlibs', lyrics: 'la', seed: 1 }).success).toBe(false);
    expect(AceLayerOptionsSchema.safeParse({ instrument: 'adlibs', voice: 'vocals', seed: 1 }).success).toBe(false);
    expect(AceLayerOptionsSchema.safeParse({ instrument: 'adlibs', lyrics: 'la', voice: 'vocals', seed: 1 }).success).toBe(true);
  });

  it('refuses a selection outside the song and a key ACE does not know', () => {
    expect(() => coveredSections(SONG, { startBar: 10_000, endBar: 10_004 })).toThrow(/outside the song/u);
    expect(() => keyScale('H')).toThrow(/not a key ACE understands/u);
    expect(keyScale('F#m')).toBe('F# minor');
  });
});

describe('rap (ACE layer)', () => {
  const verses = SONG.songStructure.filter((s) => sectionKind(s.name) === 'verse').map((s) => s.name);
  const startOf = (name: string) => {
    let bar = 0;
    for (const s of SONG.songStructure) {
      if (s.name === name) return { start: bar * SEC_PER_BAR, end: (bar + s.bars.length) * SEC_PER_BAR, bars: s.bars.length };
      bar += s.bars.length;
    }
    throw new Error(name);
  };

  it('raps the words of every section (from the song), per section, several takes each, on "Rap"', async () => {
    expect(verses.length).toBeGreaterThan(1);
    const [v1, v2] = verses as [string, string];
    const options: AceLayerOptions = { instrument: 'rap', words: 'female rap vocals', sections: [v1, v2], rapWords: { [v1]: ' one \n\n two ', [v2]: 'three\nfour' }, seed: 9 };
    // the song is rendered for ACE without its takes (no singing, no earlier rap): drums, bass and chords
    const rendered: Song[] = [];
    const sung = applyAceLayer(SONG, { track: 'ACE Guitar', instrument: 'guitar', caption: 'guitar', seed: 1, takes: [{ segment: v1, sha256: 'a'.repeat(64) as never, durationSeconds: 8, fingerprint: vocalTakeFingerprint(SONG, v1, 'ACE Guitar') as never }] });
    const { result, submitted, steps } = await run(options, { input: sung, renderWav: async (song: Song) => (rendered.push(song), join(dir, 'render.wav')) });
    expect(rendered.map((r) => r.aiArtifacts)).toEqual([[]]);
    expect(submitted).toHaveLength(1);
    const sent = submitted[0]!;
    expect(sent).toMatchObject({ track: 'vocals', takes: RAP_TAKES, seed: 9 });
    expect(sent).not.toHaveProperty('lyrics');
    expect(sent['caption']).toBe(
      `hip-hop, rap, female rap vocals, fast high-energy rap, aggressive punchy delivery, rapid-fire spoken word flow on the beat, punchy drums, no singing, no sung melody, ${SONG.bpm} bpm`,
    );
    expect(String(sent['lego_caption'])).toMatch(/^female rap vocals, rap vocals, a cappella/u);
    expect(sent['sections']).toEqual([
      { name: v1, start: startOf(v1).start, end: startOf(v1).end, lyrics: 'one\ntwo' },
      { name: v2, start: startOf(v2).start, end: startOf(v2).end, lyrics: 'three\nfour' },
    ]);
    expect(steps.map((s) => s.id)).not.toContain('words');
    expect(result.track).toBe('Rap');
    expect(result.rapLyrics).toEqual({ [v1]: ['one', 'two'], [v2]: ['three', 'four'] });
    expect(result.takes.map((t) => t.segment)).toEqual([v1, v2]);
  });

  it('rap is chosen by section, and only rap takes rap words (for its own sections)', () => {
    const [v, w] = verses as [string, string];
    expect(AceLayerOptionsSchema.safeParse({ instrument: 'rap', seed: 1 }).success).toBe(false);
    expect(AceLayerOptionsSchema.safeParse({ instrument: 'rap', sections: [v], range: { startBar: 0, endBar: 4 }, seed: 1 }).success).toBe(false);
    expect(AceLayerOptionsSchema.safeParse({ instrument: 'guitar', rapWords: { [v]: 'x' }, seed: 1 }).success).toBe(false);
    expect(AceLayerOptionsSchema.safeParse({ instrument: 'rap', sections: [v], rapWords: { [w]: 'x' }, seed: 1 }).success).toBe(false);
    expect(AceLayerOptionsSchema.safeParse({ instrument: 'rap', words: 'rap', sections: [v], rapWords: { [v]: 'x' }, seed: 1 }).success).toBe(true);
    // every section needs its words, and rap needs its style
    expect(AceLayerOptionsSchema.safeParse({ instrument: 'rap', words: 'rap', sections: [v, w], rapWords: { [v]: 'x' }, seed: 1 }).success).toBe(false);
    expect(AceLayerOptionsSchema.safeParse({ instrument: 'rap', sections: [v], rapWords: { [v]: 'x' }, seed: 1 }).success).toBe(false);
  });
});
