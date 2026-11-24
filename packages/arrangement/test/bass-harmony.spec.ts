// Bass notes fit the chord they sound against (owner, 2026-11-24): bank lines are written over C and the legacy moved
// them to each chord's root only, so minor chords got a major third (C# over Am) and bluesy lines a flat seventh out
// of the key (Eb over F in C major). fitBassNote corrects the third, seventh and fifth to the chord's own, and moves
// any other note outside both the chord and the key to the nearest note in the key.

import { describe, expect, it } from 'vitest';

import { parseChord, parseKey, scalePitchClasses } from '@casperaki/music-theory';
import { GenreSchema } from '@casperaki/song-schema';

import { orchestrate } from '../src/index.js';
import { fitBassNote } from '../src/patterns/bass.js';

const C_MAJOR = scalePitchClasses(parseKey('C'));
const A_MINOR = scalePitchClasses(parseKey('Am'));
const fit = (pitch: number, chord: string, key = C_MAJOR) => fitBassNote(pitch, parseChord(chord), key);

describe('fitBassNote', () => {
  it('gives a minor chord its minor third and a major chord its major third', () => {
    expect(fit(37, 'Am')).toBe(36); // C# -> C
    expect(fit(42, 'Dm7')).toBe(41); // F# -> F
    expect(fit(44, 'Em')).toBe(43); // G# -> G
    expect(fit(43, 'E', A_MINOR)).toBe(44); // G -> G# (the major V in a minor key)
  });

  it('plays the chord seventh, or the seventh in the key, or the root', () => {
    expect(fit(46, 'C')).toBe(47); // Bb -> B (major seventh in C major)
    expect(fit(51, 'F')).toBe(52); // Eb -> E
    expect(fit(46, 'C7')).toBe(46); // the chord's own flat seventh stays
    expect(fit(43, 'Am')).toBe(43); // G over Am: a minor seventh, in the key
  });

  it('gives a suspended chord its suspended note and a diminished chord its fifth', () => {
    expect(fit(40, 'Csus4')).toBe(41);
    expect(fit(40, 'Csus2')).toBe(38);
    expect(fit(54, 'Bdim')).toBe(53); // F# -> F
  });

  it('keeps roots, chord tones and passing notes in the key', () => {
    for (const p of [36, 38, 41, 45]) expect(fit(p, 'C')).toBe(p);
  });

  it('moves another note outside the key to the nearest one, a chord tone first', () => {
    expect(fit(42, 'C')).toBe(43); // F# over C -> G (chord tone) rather than F
    expect(fit(37, 'C')).toBe(36); // Db over C -> C (root) rather than D
  });
});

describe('generated bass lines', () => {
  it('play only notes of the chord or the key, in every style', () => {
    for (const genre of GenreSchema.options) {
      for (const [key, seed] of [['C', 'a'], ['Am', 'b'], ['F', 'c']] as const) {
        const song = orchestrate({ genre, key, bpm: 110, seed });
        const scale = scalePitchClasses(parseKey(key));
        for (const seg of song.songStructure) {
          const bars = song.arrangement[seg.name]?.overrides.Bass?.bars ?? [];
          bars.forEach((bar, i) => {
            for (const [beat, evs] of Object.entries(bar.notes ?? {})) {
              for (const ev of evs as { type: string; note?: number }[]) {
                if (ev.type !== 'note') continue;
                const chord = parseChord(seg.bars[i]!.chords[Math.floor(Number(beat))]!);
                const interval = (((ev.note! - chord.root) % 12) + 12) % 12;
                const ok = chord.intervals.some((t) => t % 12 === interval) || scale.includes(ev.note! % 12);
                expect(ok, `${genre} ${key} ${seg.name} bar ${i + 1} beat ${beat}: MIDI ${ev.note} over ${chord.raw}`).toBe(true);
                if (interval === 3 || interval === 4) {
                  expect(chord.intervals.includes(interval), `${genre} ${key} ${seg.name}: wrong third over ${chord.raw}`).toBe(true);
                }
              }
            }
          });
        }
      }
    }
  });
});
