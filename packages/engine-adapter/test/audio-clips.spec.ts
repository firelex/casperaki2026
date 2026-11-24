import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SongSchema, type Song } from '@casperaki/song-schema';
import { describe, expect, it } from 'vitest';

import { toEngineFixture } from '../src/index.js';

const GOLDEN = resolve(dirname(fileURLToPath(import.meta.url)), '../../arrangement/test/fixtures/golden/orchestrate/brightPop/brightPop-vertical-slice.song.json');
const base = (): Song => SongSchema.parse(JSON.parse(readFileSync(GOLDEN, 'utf8')));
const FP = (c: string) => c.repeat(64);
const take = (segment: string, fp: string, instrument = 'Vocal') => ({
  id: `vocal-${segment}`, kind: 'soulx-vocal' as const, modelId: 'soulx-singer', modelVersion: 'steps-32', seed: 1, prompt: 'en_prompt',
  conditioning: { hashes: [fp] }, output: { uri: `vocal-take:${fp}.ogg`, sha256: fp, lufs: -24, durationSeconds: 9.6 },
  attachedTo: { scope: 'segment' as const, segment, instrument },
});
const lower = (song: Song, vocalTakesDir?: string) =>
  toEngineFixture(song, { brainHash: 'x', generatorParams: {}, ...(vocalTakesDir ? { vocalTakesDir } : {}) });
const clipsInsts = (f: ReturnType<typeof lower>) => f.instruments.map((i) => i.json as Record<string, any>).filter((j) => j.type === 'audioClips');
const clipsInst = (f: ReturnType<typeof lower>) => clipsInsts(f).find((j) => j.name === 'Vocal');

describe('sung vocal takes lowered to an audioClips instrument', () => {
  it('no takes: no audioClips instrument (Vocal stays silent)', () => {
    expect(clipsInst(lower(base()))).toBeUndefined();
  });

  it('takes play whether or not Play sings missing sections (the switch only controls singing)', () => {
    const off = { ...base(), vocals: { enabled: false, voice: 'en_prompt', takeNumbers: {} }, aiArtifacts: [take('verse1', FP('a'))] } as Song;
    expect(clipsInst(lower(off, '/takes'))!.clips).toHaveLength(1);
  });

  it('vocals on: one clip per section take, keyed by the take, from the takes directory', () => {
    const on = { ...base(), vocals: { enabled: true, voice: 'en_prompt', takeNumbers: {} }, aiArtifacts: [take('verse1', FP('a')), take('chorus1', FP('b'))] } as Song;
    const inst = clipsInst(lower(on, '/data/takes'))!;
    expect(inst).toMatchObject({ name: 'Vocal', type: 'audioClips', lowLevelType: 'vocalsLaSinger' });
    expect(typeof inst.id).toBe('number');
    expect(inst.clips).toEqual([
      { segment: 'verse1', key: `take-${FP('a')}.ogg`, sourcePath: `/data/takes/${FP('a')}.ogg`, durationSec: 9.6 },
      { segment: 'chorus1', key: `take-${FP('b')}.ogg`, sourcePath: `/data/takes/${FP('b')}.ogg`, durationSec: 9.6 },
    ]);
  });

  it('each vocal track with takes gets its own lane (backing vocals separately from the lead)', () => {
    const on = { ...base(), aiArtifacts: [take('verse1', FP('a')), take('chorus1', FP('c'), 'Backing vocals 1')] } as Song;
    const insts = clipsInsts(lower(on, '/t'));
    expect(insts.map((j) => j.name)).toEqual(['Vocal', 'Backing vocals 1']);
    expect(new Set(insts.map((j) => j.id)).size).toBe(2);
    expect(insts[1]!.clips).toEqual([{ segment: 'chorus1', key: `take-${FP('c')}.ogg`, sourcePath: `/t/${FP('c')}.ogg`, durationSec: 9.6 }]);
  });

  it('vocals on with takes but no takes directory: an error naming the setting', () => {
    const on = { ...base(), vocals: { enabled: true, voice: 'en_prompt', takeNumbers: {} }, aiArtifacts: [take('verse1', FP('a'))] } as Song;
    expect(() => lower(on)).toThrow(/CASPERAKI_VOCAL_TAKES_DIR/);
  });
});
