import { describe, expect, it } from 'vitest';

import { applyLyricsFirst, orchestrate, vocalAsPiano, wordlessMelodyAsPiano } from '../src/index.js';

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

// Owner 2026-11-28: "When I have a melody but no lyrics, can the same piano sound that plays the vocals solo in the
// details view play it over the song with the rest of the instruments?"
describe('wordlessMelodyAsPiano (playback of a melody without lyrics)', () => {
  const full = orchestrate({ genre: 'brightPop', key: 'E', bpm: 110, seed: 'vocal-piano' });
  const events = (song: typeof full, track: string) =>
    Object.values(song.arrangement).flatMap((a) => (a.overrides[track]?.bars ?? []).flatMap((b) => Object.values(b.notes ?? {}).flat())) as { type: string; note: number; duration: number }[];

  it('the lead track keeps its name and plays its notes on the preview piano, with the rest of the song', () => {
    const out = wordlessMelodyAsPiano(full);
    const def = out.instrumentDefinitions.find((d) => d.name === 'Vocal')!;
    const pianoDef = vocalAsPiano({ ...full, instrumentDefinitions: [full.instrumentDefinitions.find((d) => d.name === 'Vocal')!] }, 'Vocal');
    expect(def.lowLevelType).toBe('keysAcousticPiano');
    expect(def.shortName).toBe(pianoDef.song.instrumentDefinitions[0]!.shortName);
    expect(events(out, 'Vocal').map((e) => [e.type, e.note, e.duration])).toEqual(events(full, 'Vocal').map((e) => ['note', e.note, e.duration]));
    // every other track is as it was
    for (const d of full.instrumentDefinitions.filter((x) => x.name !== 'Vocal')) {
      expect(out.instrumentDefinitions.find((x) => x.name === d.name)).toEqual(d);
      expect(events(out, d.name)).toEqual(events(full, d.name));
    }
  });

  it('a melody with lyrics is left as it is', () => {
    const withWords = applyLyricsFirst(full, {
      verse: ['Met you at the corner store', 'A name I do not know', 'You said it was nothing', 'But I could see it show'],
      chorus: ['Hold me closer in the light', 'We could stay up all the night', 'Every heartbeat feels so right', 'Hold me closer hold me tight'],
    });
    expect(wordlessMelodyAsPiano(withWords)).toBe(withWords);
  });

  it('a song without a lead melody is left as it is', () => {
    const noVocal = { ...full, instrumentDefinitions: full.instrumentDefinitions.filter((d) => d.name !== 'Vocal') };
    expect(wordlessMelodyAsPiano(noVocal)).toBe(noVocal);
  });
});
