import { describe, expect, it } from 'vitest';
import { parseChord, parseKey } from '@casperaki/music-theory';

import { orchestrate } from '../src/index.js';
import { keyOffsetFromC, transposeChordSymbol } from '../src/vocals/fit.js';

const MAJOR = [0, 2, 4, 5, 7, 9, 11];

function vocalStats(key: string, genre: string) {
  const s = orchestrate({ genre, key, bpm: 110, seed: `fit-${key}` });
  const k = parseKey(key);
  const rel = k.mode === 'minor' ? (k.tonic + 3) % 12 : k.tonic;
  let n = 0, inKey = 0, chordTones = 0, lo = 127, hi = 0;
  for (const seg of s.songStructure) {
    const vocal = s.arrangement[seg.name]?.overrides?.['Vocal'];
    if (!vocal) continue;
    vocal.bars!.forEach((bar, i) => {
      for (const [beatKey, events] of Object.entries(bar.notes ?? {})) {
        for (const e of events as { type: string; note: number }[]) {
          if (e.type !== 'vocalNote') continue;
          n++;
          const pc = e.note % 12;
          const chords = seg.bars[i]!.chords;
          const c = parseChord(chords[Math.min(chords.length - 1, Math.floor(parseFloat(beatKey)))]!);
          const chordTone = c.intervals.some((iv) => (c.root + iv) % 12 === pc);
          // In the key, or on a borrowed chord's tone (hooks may borrow bVII, bVI, secondary dominants).
          if (MAJOR.includes((((pc - rel) % 12) + 12) % 12) || chordTone) inKey++;
          if (chordTone) chordTones++;
          lo = Math.min(lo, e.note);
          hi = Math.max(hi, e.note);
        }
      }
    });
  }
  return { n, inKey: inKey / n, chordTones: chordTones / n, lo, hi };
}

describe('vocal melody fits the song', () => {
  it('is sung in the song key, within the singer range, on the section chords', () => {
    // Chord tones vary with the borrowed melody's passing notes: a floor per
    // song, and the average well above chance (about 44% for scale notes).
    const fits: number[] = [];
    for (const key of ['C', 'E', 'Bb', 'F#', 'Am']) {
      for (const genre of ['brightPop', 'ballad']) {
        const st = vocalStats(key, genre);
        expect(st.n).toBeGreaterThan(50);
        expect(st.inKey).toBeGreaterThan(0.97);
        // 0.45: the legacy remix of verses and choruses gives some seeds sections near 0.35 (E brightPop since the
        // pre-chorus and bridge rules draw a bank first, 2026-11-24); the average below is the real check.
        expect(st.chordTones).toBeGreaterThan(0.45);
        fits.push(st.chordTones);
        expect(st.lo).toBeGreaterThanOrEqual(55); // G3 (legacy index 43)
        expect(st.hi).toBeLessThanOrEqual(76); // E5: hooks reach bank 64 (bank-index hooks.maxNote); legacy entries stay at or below B4
      }
    }
    expect(fits.reduce((a, b) => a + b, 0) / fits.length).toBeGreaterThan(0.62);
  });
  it('moves chords and finds the key offset (minor keys via their relative major)', () => {
    expect(transposeChordSymbol('A#maj7', 2)).toBe('Cmaj7');
    expect(transposeChordSymbol('C/E', 7)).toBe('G/B');
    expect(keyOffsetFromC('E')).toBe(4);
    expect(keyOffsetFromC('Am')).toBe(0);
    expect(keyOffsetFromC('F#m')).toBe(9);
  });
});
