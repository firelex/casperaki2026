import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SongSchema, vocalTakeFingerprint, type Sha256, type Song } from '@casperaki/song-schema';
import { describe, expect, it } from 'vitest';

import { DRY_SENDS, WET_SENDS } from '../src/audio-clips.js';
import { toEngineFixture } from '../src/index.js';

const GOLDEN = resolve(dirname(fileURLToPath(import.meta.url)), '../../arrangement/test/fixtures/golden/orchestrate/brightPop/brightPop-vertical-slice.song.json');
const base = (): Song => SongSchema.parse(JSON.parse(readFileSync(GOLDEN, 'utf8')));
const SONG = base();
type Kind = 'yue2-vocal' | 'soulx-vocal';
const fpOf = (segment: string, track = 'Vocal') => vocalTakeFingerprint(SONG, segment, track);
const take = (segment: string, instrument = 'Vocal', kind: Kind = 'yue2-vocal', fp = fpOf(segment, instrument)) => ({
  id: `vocal-${segment}-${instrument}-${kind}`, kind, modelId: 'soulx-singer', modelVersion: 'steps-32', seed: 1, prompt: 'en_prompt',
  conditioning: { hashes: [fp as Sha256] }, output: { uri: `vocal-take:${fp}.ogg`, sha256: fp, lufs: -24, durationSeconds: 9.6 },
  attachedTo: { scope: 'segment' as const, segment, instrument },
});
const clip = (segment: string, track = 'Vocal', dir = '/t') => ({ segment, key: `take-${fpOf(segment, track)}.ogg`, sourcePath: `${dir}/${fpOf(segment, track)}.ogg`, durationSec: 9.6 });
const lower = (song: Song, vocalTakesDir?: string) =>
  toEngineFixture(song, { brainHash: 'x', generatorParams: {}, ...(vocalTakesDir ? { vocalTakesDir } : {}) });
const clipsInsts = (f: ReturnType<typeof lower>) => f.instruments.map((i) => i.json as Record<string, any>).filter((j) => j.type === 'audioClips');
const clipsInst = (f: ReturnType<typeof lower>) => clipsInsts(f).find((j) => j.name === 'Vocal');

describe('sung vocal takes lowered to an audioClips instrument', () => {
  it('no takes: no audioClips instrument (Vocal stays silent)', () => {
    expect(clipsInst(lower(base()))).toBeUndefined();
  });

  it('takes play whether or not Play sings missing sections (the switch only controls singing)', () => {
    const off = { ...base(), vocals: { enabled: false, voice: 'en_prompt', takeNumbers: {} }, aiArtifacts: [take('verse1')] } as Song;
    expect(clipsInst(lower(off, '/takes'))!.clips).toHaveLength(1);
  });

  it('vocals on: one clip per section take, keyed by the take, from the takes directory', () => {
    const on = { ...base(), vocals: { enabled: true, voice: 'en_prompt', takeNumbers: {} }, aiArtifacts: [take('verse1'), take('chorus1')] } as Song;
    const inst = clipsInst(lower(on, '/data/takes'))!;
    expect(inst).toMatchObject({ name: 'Vocal', type: 'audioClips', lowLevelType: 'vocalsLaSinger' });
    expect(typeof inst.id).toBe('number');
    expect(inst.clips).toEqual([clip('verse1', 'Vocal', '/data/takes'), clip('chorus1', 'Vocal', '/data/takes')]);
  });

  it('each vocal track with takes gets its own lane (backing vocals separately from the lead)', () => {
    const on = { ...base(), aiArtifacts: [take('verse1'), take('chorus1', 'Backing vocals 1')] } as Song;
    const insts = clipsInsts(lower(on, '/t'));
    expect(insts.map((j) => j.name)).toEqual(['Vocal', 'Backing vocals 1']);
    expect(new Set(insts.map((j) => j.id)).size).toBe(2);
    expect(insts[1]!.clips).toEqual([clip('chorus1', 'Backing vocals 1')]);
  });

  it('vocals on with takes but no takes directory: an error naming the setting', () => {
    const on = { ...base(), vocals: { enabled: true, voice: 'en_prompt', takeNumbers: {} }, aiArtifacts: [take('verse1')] } as Song;
    expect(() => lower(on)).toThrow(/CASPERAKI_VOCAL_TAKES_DIR/);
  });

  it('yue2 takes go on the dry lane, soulx takes on the wet lane with their own sends; stale takes are left out', () => {
    const on = { ...base(), aiArtifacts: [take('chorus1', 'Vocal', 'yue2-vocal'), take('verse1', 'Vocal', 'soulx-vocal')] } as Song;
    const insts = clipsInsts(lower(on, '/t'));
    expect(insts.map((j) => j.name)).toEqual(['Vocal', 'Vocal wet']);
    expect(insts[0]).toMatchObject({ fxSends: DRY_SENDS, clips: [clip('chorus1')] });
    expect(insts[1]).toMatchObject({ fxSends: WET_SENDS, clips: [clip('verse1')] });
    expect(DRY_SENDS).toEqual({ reverb: -100, delay: -100, chorus: -100 });
    expect(WET_SENDS).toEqual({ reverb: -10, delay: -18, chorus: -100 });
  });

  it('a take whose fingerprint no longer matches plays nothing', () => {
    const stale = { ...base(), aiArtifacts: [take('verse1', 'Vocal', 'soulx-vocal', 'e'.repeat(64))] } as Song;
    expect(clipsInsts(lower(stale, '/t'))).toEqual([]);
  });

  it('an Ad-libs yue2 take has its own dry lane', () => {
    const on = { ...base(), aiArtifacts: [take('chorus1', 'Ad-libs', 'yue2-vocal')] } as Song;
    const insts = clipsInsts(lower(on, '/t'));
    expect(insts.map((j) => j.name)).toEqual(['Ad-libs']);
    expect(insts[0]).toMatchObject({ fxSends: DRY_SENDS });
  });
});
