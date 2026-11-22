import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createRng } from '@casperaki/music-theory';

import { selectCenteredBankPattern } from '../src/patterns/bass-generators.js';

const FILES: Record<string, string> = {
  edmComplex: 'edm/edmComplex.json',
  latin: 'library/latin.json',
  brightPop: 'library/brightPop.json',
  organicVibes: 'library/organicVibes.json',
  rock: 'library/rock.json',
};

/**
 * The legacy LibraryBassPatternGeneratorClass (lines 54-113), in its own
 * units: note-table indices from the note names, where index 0 is 'c0' and
 * the engine reads 'c0' as MIDI 12. Returns engine MIDI.
 */
function legacyCentered(notes: { note: string; midi: number }[]): number[] {
  const PC: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
  // Tools.getNoteIndexFull: undefined for names outside the table (octave -1).
  const nameIndex = (n: string): number | undefined => {
    const m = /^([a-g])(#|b)?(-?\d+)$/u.exec(n.toLowerCase());
    if (!m) throw new Error(`unreadable note ${n}`);
    if (Number(m[3]) < 0) return undefined;
    return Number(m[3]) * 12 + PC[m[1]!]! + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  };
  const stat = notes.map((n) => nameIndex(n.note) || n.midi); // `if (!noteIndex) noteIndex = midi`
  const avg = stat.reduce((a, b) => a + b, 0) / stat.length;
  let cNeighbor = Math.round(avg / 12) * 12;
  if (Math.min(...stat) + 24 - cNeighbor < 0) cNeighbor -= 12;
  // notes[index + 24 - c][0]; an undefined index throws → catch → midi.
  return notes.map((n) => (nameIndex(n.note) ?? n.midi) + 24 - cNeighbor + 12);
}

describe('centred bass banks (Library / edmComplex)', () => {
  it('put every note where the legacy did', () => {
    for (const [style, file] of Object.entries(FILES)) {
      const bank = JSON.parse(readFileSync(resolve(__dirname, '../data/patterns/bass', file), 'utf8'));
      const patterns = Array.isArray(bank) ? bank : bank.patterns;
      for (let seed = 0; seed < 6; seed++) {
        const sel = selectCenteredBankPattern(createRng(`bass-octave-${style}-${seed}`), style, 'major');
        if (sel.mode !== 'absolute') throw new Error('expected an absolute selection');
        const notes = Object.values(patterns[sel.patternIndex].notesMajor as Record<string, { note: string; midi: number }[]>).flat();
        expect(sel.events.map((e) => e.midi)).toEqual(legacyCentered(notes));
      }
    }
  });
});
