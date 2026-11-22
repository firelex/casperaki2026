import { describe, expect, it } from 'vitest';

import { orchestrate, vocalAsPiano } from '../src/index.js';

describe('vocalAsPiano', () => {
  it('plays a sung part on an acoustic piano: same pitches and lengths', () => {
    const full = orchestrate({ genre: 'brightPop', key: 'E', bpm: 110, seed: 'vocal-piano' });
    const seg = full.songStructure.find((s) => s.name === 'chorus1')!;
    const def = full.instrumentDefinitions.find((d) => d.name === 'Vocal')!;
    const vocal = full.arrangement['chorus1']!.overrides['Vocal']!;
    const preview = {
      ...full,
      songStructure: [seg],
      arrangement: { chorus1: { ...full.arrangement['chorus1']!, instruments: { Vocal: true }, overrides: { Vocal: vocal }, signalProcessors: {} } },
      instrumentDefinitions: [def],
    };
    const { song, piano } = vocalAsPiano(preview, 'Vocal');
    expect(piano.lowLevel).toBe('keysAcousticPiano');
    expect(song.instrumentDefinitions).toHaveLength(1);
    expect(song.instrumentDefinitions[0]!.name).toBe('Keys');
    const sung = vocal.bars!.flatMap((b) => Object.values(b.notes ?? {}).flat()) as { note: number; duration: number }[];
    const played = song.arrangement['chorus1']!.overrides['Keys']!.bars!.flatMap((b) => Object.values(b.notes ?? {}).flat()) as { type: string; note: number; duration: number }[];
    expect(played.map((e) => [e.type, e.note, e.duration])).toEqual(sung.map((e) => ['note', e.note, e.duration]));
    expect(() => vocalAsPiano(full, 'Vocal')).toThrow(/only the track/);
  });
});
