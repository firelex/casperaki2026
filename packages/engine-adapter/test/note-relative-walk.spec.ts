import { describe, expect, it } from 'vitest';

import { orchestrate } from '@casperaki/arrangement';

import { toEngineFixture } from '../src/index.js';

type Ev = { type: string; distanceFromMiddleC?: number; octave?: number; direction?: string; note?: number; offset?: number };
type Env = { arrangement: Record<string, { overrides: Record<string, { bars?: Array<{ notes?: Record<string, Ev[]> }> }> }> };

describe('noteRelative chord walk (playful lead synths)', () => {
  it('passes octave + direction + note + offset through to the engine', () => {
    // The first of a fixed list of songs whose lead synth uses 'playful'
    // (legacy PlayfulSynthPatternGeneratorClass; analog leads use the piano library).
    let walks = 0;
    for (const genre of ['rock', 'ballad', 'urban']) {
      for (let i = 0; i < 40 && walks === 0; i++) {
        const params = { genre, key: 'C', bpm: 120, seed: `walk-${i}` };
        const song = orchestrate(params);
        const env = toEngineFixture(song, { brainHash: 'h', generatorParams: params }).songJson as Env;
        for (const seg of Object.values(env.arrangement)) {
          for (const bar of seg.overrides['Synths']?.bars ?? []) {
            for (const evs of Object.values(bar.notes ?? {})) {
              for (const ev of evs) {
                if (ev.type !== 'noteRelative' || ev.distanceFromMiddleC !== undefined) continue;
                expect([4, 5]).toContain(ev.octave);
                expect(ev.direction).toBe('center');
                expect(typeof ev.note).toBe('number');
                expect(typeof ev.offset).toBe('number');
                walks++;
              }
            }
          }
        }
      }
      if (walks > 0) break;
    }
    expect(walks).toBeGreaterThan(0);
  });

  it('refuses a noteRelative event with neither encoding', () => {
    const params = { genre: 'urban', key: 'C', bpm: 120, seed: 'walk-0' };
    const song = orchestrate(params);
    const seg = song.songStructure.find((s) => song.arrangement[s.name]?.overrides?.['Synths'])!;
    const synths = song.arrangement[seg.name]!.overrides['Synths']!;
    synths.bars![0]!.notes = { '0.0': [{ type: 'noteRelative', chord: 'C', duration: 1 } as never] };
    expect(() => toEngineFixture(song, { brainHash: 'h', generatorParams: params })).toThrow(/neither distanceFromMiddleC nor octave/);
  });
});
