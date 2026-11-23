import { describe, expect, it } from 'vitest';

import { hum, orchestrate } from '../src/index.js';

// An 8-bar hummed chorus in E major (real MIDI): a rising figure, then an answer.
const MELODY = [
  { beat: 0, midi: 64, duration: 1 }, { beat: 1, midi: 66, duration: 1 }, { beat: 2, midi: 68, duration: 2 },
  { beat: 4, midi: 71, duration: 1.5 }, { beat: 5.5, midi: 69, duration: 0.5 }, { beat: 6, midi: 68, duration: 2 },
  { beat: 8, midi: 66, duration: 1 }, { beat: 9, midi: 64, duration: 1 }, { beat: 10, midi: 66, duration: 2 },
  { beat: 12, midi: 68, duration: 4 },
  { beat: 16, midi: 64, duration: 1 }, { beat: 17, midi: 66, duration: 1 }, { beat: 18, midi: 68, duration: 2 },
  { beat: 20, midi: 73, duration: 2 }, { beat: 22, midi: 71, duration: 2 },
  { beat: 24, midi: 69, duration: 1 }, { beat: 25, midi: 68, duration: 1 }, { beat: 26, midi: 66, duration: 2 },
  { beat: 28, midi: 64, duration: 4 },
];
const CHORDS = ['E', 'E', 'A', 'A', 'B', 'B', 'E', 'E', 'E', 'E', 'A', 'A', 'B', 'B', 'E', 'E'];

describe('user chorus (hum to song)', () => {
  it('is sung as every chorus, in its own rhythm and pitch classes, over its chords', () => {
    const song = orchestrate({ genre: 'brightPop', key: 'E', bpm: 110, seed: 'hum-test', params: { userChorus: { melody: MELODY, chords: CHORDS } } });
    const choruses = song.songStructure.filter((s) => s.name.startsWith('chorus'));
    expect(choruses.length).toBeGreaterThan(0);
    for (const seg of choruses) {
      // Chords: two per bar as given (bars beyond 8 repeat the 8-bar chorus).
      seg.bars.forEach((bar, i) => {
        const j = i % 8;
        expect(bar.chords[0]).toBe(CHORDS[j * 2]);
        expect(bar.chords[2]).toBe(CHORDS[j * 2 + 1]);
      });
      const vocal = song.arrangement[seg.name]?.overrides?.['Vocal'];
      expect(vocal).toBeDefined();
      const sung: { beat: number; note: number }[] = [];
      vocal!.bars!.slice(0, 8).forEach((bar, i) => {
        for (const [beatKey, events] of Object.entries(bar.notes ?? {})) {
          for (const e of events as { type: string; note: number }[]) if (e.type === 'vocalNote') sung.push({ beat: i * 4 + parseFloat(beatKey), note: e.note });
        }
      });
      sung.sort((a, b) => a.beat - b.beat);
      expect(sung.map((s) => s.beat)).toEqual(MELODY.map((m) => m.beat));
      // Same pitch classes, one octave shift for the whole melody (moved into the singing range).
      const shift = sung[0]!.note - MELODY[0]!.midi;
      expect(shift % 12).toBe(0);
      expect(sung.map((s) => s.note - shift)).toEqual(MELODY.map((m) => m.midi));
    }
  });

  it('rejects a malformed chorus, naming the field', () => {
    expect(() => orchestrate({ genre: 'brightPop', key: 'E', bpm: 110, seed: 'x', params: { userChorus: { melody: MELODY, chords: CHORDS.slice(1) } } })).toThrow(/userChorus: chords/u);
  });

  it('loads the chord-fit model and harmonises a melody', () => {
    const model = hum.loadChordFitModel();
    const { alternatives } = hum.harmonize(MELODY, 8, 4, model.prior, model.known, { ...model.params, fill: model.fillByMelodyBars['8']! });
    expect(alternatives).toHaveLength(3);
    const first = alternatives[0]!.slots.map((id) => hum.chordSymbol(hum.chordFromId(id), 4));
    expect(first).toHaveLength(16);
    expect(first[0]).toMatch(/^E/u);
  });
});
