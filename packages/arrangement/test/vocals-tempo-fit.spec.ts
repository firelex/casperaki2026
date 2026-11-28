// Tempo fit of vocal melodies (bank-index tempoFit, src/vocals/precedents.ts "tempo fit"): every selection draws
// from entries with at most maxNotesPerSecond notes per second at the song's tempo, and from halfTimeFromBpm on also
// from half-time copies (twice as long), so fast songs sing long notes (owner, 2026-11-25: busy melodies only over
// slow songs, long notes over fast ones).

import { GENRE_TEMPO_RANGES } from '@casperaki/song-schema';
import { createRng } from '@casperaki/music-theory';
import { afterEach, describe, expect, it } from 'vitest';

import { parseHookText } from '../src/vocals/hook-text.js';
import {
  halfTimeCopy,
  loadBankIndex,
  selectMergedPrecedent,
  setPrecedentDataForTests,
  tempoBank,
  type Precedent,
} from '../src/vocals/precedents.js';

// Two chorus hooks: Busy has 4 notes a bar (16ths and 8ths aside, quarter notes), Sparse 1 note a bar.
const HOOK_TEXT = `
hook: Busy
type: Chorus
tempo: 60-160
feel: driving
chords: C | G | Am | F | C | G | F | C
melody: e4:1 g4:1 e4:1 c4:1 | d4:1 g4:1 d4:1 b3:1 | c4:1 e4:1 a4:1 e4:1 | f4:1 a4:1 f4:1 c4:1 |
        e4:1 g4:1 e4:1 c4:1 | d4:1 g4:1 d4:1 b3:1 | c4:1 f4:1 a4:1 f4:1 | e4:1 g4:1 e4:2 |

hook: Sparse
type: Chorus
tempo: 60-160
feel: soaring
chords: C | G | Am | F | C | G | F | C
melody: e4:4 | d4:4 | e4:4 | f4:4 | g4:4 | d4:4 | c4:4 | c4:4 |
`;
const parsed = parseHookText(HOOK_TEXT, 'tf');
if (parsed.errors.length > 0) throw new Error(`fixture hooks do not parse: ${parsed.errors.join('; ')}`);
const [BUSY, SPARSE] = parsed.hooks as unknown as Precedent[];

function useIndex(tempoFit: unknown): void {
  setPrecedentDataForTests({
    index: {
      $schemaVersion: 1,
      banks: { hooks: { file: 'hooks.json' } },
      wholeShare: 0.5,
      tempoFit,
      hooks: { bank: 'hooks', maxNote: { chorus: 64 } },
      genres: { g: { chorus: { melodic: ['hooks'] } } },
    },
    files: { 'hooks.json': parsed.hooks },
  });
}

afterEach(() => setPrecedentDataForTests(undefined));

const notesPerSecond = (melody: Record<string, unknown>, bars: number, bpm: number) => ((Object.keys(melody).length / bars) * bpm) / 240;

describe('half-time copy', () => {
  it('doubles every position and length, holds each chord two beats, doubles the tempo (and range), halves busyness', () => {
    // A hook's tempo is the middle of its range (60-160: "110").
    const h = halfTimeCopy(SPARSE!);
    expect(h.id).toBe(`${SPARSE!.id}@half`);
    expect(h.properties).toMatchObject({ start: 0, end: 16, tempoMin: 120, tempoMax: 320, tempo: '220', busyness: 0.5, halfTime: true });
    expect(Object.keys(h.melody)).toEqual(Object.keys(SPARSE!.melody).map((b) => `${parseFloat(b) * 2}`.replace(/^(\d+)$/u, '$1.0')));
    for (const [b, notes] of Object.entries(SPARSE!.melody)) {
      const key = `${parseFloat(b) * 2}`.replace(/^(\d+)$/u, '$1.0');
      expect(h.melody[key]![0]).toMatchObject({ midi: notes[0]!.midi, duration: notes[0]!.duration * 2 });
    }
    expect(Object.keys(h.chords)).toHaveLength(Object.keys(SPARSE!.chords).length * 2);
    expect(h.chords['2.0']).toEqual(SPARSE!.chords['1.0']);
    expect(h.chords['3.0']).toEqual(SPARSE!.chords['1.0']);
  });
});

describe('tempo pool', () => {
  it('drops entries busier than maxNotesPerSecond at the song tempo', () => {
    // Busy: 4 notes a bar = 2.0 notes/s at 120 bpm, 1.0 at 60. Sparse: 0.5 at 120.
    useIndex({ maxNotesPerSecond: 1.6, halfTimeFromBpm: 1000 });
    expect(tempoBank('hooks', 60).map((e) => e.id)).toEqual([BUSY!.id, SPARSE!.id]);
    expect(tempoBank('hooks', 120).map((e) => e.id)).toEqual([SPARSE!.id]);
    // The cap is inclusive: 4 notes a bar at 96 bpm is exactly 1.6 notes/s.
    expect(tempoBank('hooks', 96).map((e) => e.id)).toEqual([BUSY!.id, SPARSE!.id]);
  });

  it('adds the half-time copies that fit from halfTimeFromBpm on (not below)', () => {
    useIndex({ maxNotesPerSecond: 1.6, halfTimeFromBpm: 110 });
    expect(tempoBank('hooks', 109).map((e) => e.id)).toEqual([SPARSE!.id]);
    // At 120 bpm Busy in half time is 2 notes a bar = 1.0 notes/s: it fits; Sparse fits both ways.
    expect(tempoBank('hooks', 120).map((e) => e.id)).toEqual([SPARSE!.id, `${BUSY!.id}@half`, `${SPARSE!.id}@half`]);
  });

  it('a bank index without tempoFit is refused', () => {
    useIndex(undefined);
    expect(() => loadBankIndex()).toThrow(/tempoFit/);
  });
});

describe('selection follows the tempo pool', () => {
  it('a fast song never sings the busy hook as written; it may sing it in half time', () => {
    useIndex({ maxNotesPerSecond: 1.6, halfTimeFromBpm: 110 });
    const picks = Array.from({ length: 40 }, (_, i) =>
      selectMergedPrecedent({ desiredPatternLength: 8, segmentType: 'chorus', genre: 'g', tempo: 128, rng: createRng(`tf-${i}`) })!,
    );
    for (const m of picks) {
      expect(String(m.rhythmicPrecedentId)).not.toBe(String(BUSY!.id));
      expect(notesPerSecond(m.melody, 8, 128)).toBeLessThanOrEqual(1.6);
    }
    expect(picks.some((m) => String(m.rhythmicPrecedentId).endsWith('@half'))).toBe(true);
  });
});

describe('the real banks', () => {
  it('make a melody within the cap for every genre, at both ends of its tempo range, in every sung section type', () => {
    const { maxNotesPerSecond } = loadBankIndex().tempoFit;
    const index = loadBankIndex();
    for (const [genre, range] of Object.entries(GENRE_TEMPO_RANGES)) {
      for (const tempo of [range.min, range.max]) {
        for (const segmentType of Object.keys(index.genres[genre]!)) {
          for (let i = 0; i < 4; i++) {
            const m = selectMergedPrecedent({ desiredPatternLength: 8, segmentType, genre, tempo, rng: createRng(`real-${genre}-${tempo}-${segmentType}-${i}`) })!;
            const notes = Object.keys(m.melody).filter((b) => parseFloat(b) < 32).length;
            expect(((notes / 8) * tempo) / 240, `${genre} ${tempo} bpm ${segmentType}`).toBeLessThanOrEqual(maxNotesPerSecond + 1e-9);
          }
        }
      }
    }
  });
});

describe('the shipped tempo fit (owner 2026-11-28: "normal busy lines - not whole and half notes everywhere")', () => {
  it('a 120 bpm verse sings normal busy lines: at least 3 notes a bar on average across songs', async () => {
    const { orchestrate } = await import('../src/index.js');
    const perBar: number[] = [];
    for (let i = 0; i < 8; i++) {
      const s = orchestrate({ genre: 'casperakiPop', key: 'C', bpm: 120, seed: `busy-${i}` });
      const v = s.arrangement['verse1']?.overrides['Vocal'] as { bars: { notes: Record<string, unknown[]> }[] } | undefined;
      if (!v) continue;
      const n = v.bars.reduce((a, b) => a + Object.values(b.notes).reduce((x, evs) => x + evs.length, 0), 0);
      perBar.push(n / v.bars.length);
    }
    expect(perBar.length).toBeGreaterThan(4);
    const mean = perBar.reduce((a, b) => a + b, 0) / perBar.length;
    expect(mean, JSON.stringify(perBar)).toBeGreaterThanOrEqual(3);
  });
});
