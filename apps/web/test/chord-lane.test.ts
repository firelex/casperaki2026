import { describe, expect, it } from 'vitest';

import { buildSequencerModel } from '../src/editor/sequencerModel';
import { CHORD_CHAR_W, CHORD_PAD, chordCellAt, chordCells, chordLabel } from '../src/editor/sequencer/chordCells';
import { makeFixtureSong } from './fixture';

const sec = (startBar: number, chordsByBar: string[][], bars = chordsByBar.length) => ({ startBar, bars, chordsByBar });

describe('chord lane cells', () => {
  it('gives a bar held on one chord one cell on its bar lines', () => {
    expect(chordCells([sec(0, [['C', 'C', 'C', 'C'], ['G', 'G', 'G', 'G']])])).toEqual([
      { chord: 'C', start: 0, end: 1, section: 0 },
      { chord: 'G', start: 1, end: 2, section: 0 },
    ]);
  });

  it('splits a bar with two chords into halves (one entry per beat, as the engine reads them)', () => {
    expect(chordCells([sec(0, [['C', 'C', 'G', 'G']])])).toEqual([
      { chord: 'C', start: 0, end: 0.5, section: 0 },
      { chord: 'G', start: 0.5, end: 1, section: 0 },
    ]);
    // A chord on every beat: quarters.
    expect(chordCells([sec(0, [['C', 'G', 'Am', 'F']])]).map((c) => [c.start, c.end])).toEqual([
      [0, 0.25],
      [0.25, 0.5],
      [0.5, 0.75],
      [0.75, 1],
    ]);
    // Two entries: equal halves as well.
    expect(chordCells([sec(0, [['C', 'G']])]).map((c) => c.end)).toEqual([0.5, 1]);
  });

  it('merges repeated chords across bars but not across sections', () => {
    const cells = chordCells([
      sec(0, [['Am', 'Am', 'Am', 'Am'], ['Am', 'Am', 'F', 'F'], ['F', 'F', 'F', 'F']]),
      sec(3, [['F', 'F', 'F', 'F']]),
    ]);
    expect(cells).toEqual([
      { chord: 'Am', start: 0, end: 1.5, section: 0 },
      { chord: 'F', start: 1.5, end: 3, section: 0 },
      { chord: 'F', start: 3, end: 4, section: 1 },
    ]);
  });

  it('leaves a gap for bars without chords and does not merge over it', () => {
    const cells = chordCells([sec(0, [['C'], [], ['C']])]);
    expect(cells.map((c) => [c.start, c.end])).toEqual([
      [0, 1],
      [2, 3],
    ]);
    expect(chordCellAt(cells, 1.5)).toBe(-1);
  });

  it('ignores chord rows beyond the section length', () => {
    expect(chordCells([sec(0, [['C'], ['G']], 1)])).toHaveLength(1);
  });

  it('finds the cell under a position', () => {
    const cells = chordCells([sec(0, [['C', 'C', 'G', 'G'], ['F', 'F', 'F', 'F']])]);
    expect(chordCellAt(cells, 0)).toBe(0);
    expect(chordCellAt(cells, 0.49)).toBe(0);
    expect(chordCellAt(cells, 0.5)).toBe(1);
    expect(chordCellAt(cells, 1.99)).toBe(2);
    expect(chordCellAt(cells, 2)).toBe(-1);
    expect(chordCellAt(cells, -0.1)).toBe(-1);
  });

  it('builds cells from the song the sequencer shows', () => {
    const { song } = makeFixtureSong();
    const m = buildSequencerModel(song);
    const cells = chordCells(m.sections);
    expect(cells.length).toBeGreaterThan(0);
    for (let i = 1; i < cells.length; i++) expect(cells[i]!.start).toBeGreaterThanOrEqual(cells[i - 1]!.end - 1e-9);
    expect(cells[cells.length - 1]!.end).toBeLessThanOrEqual(m.totalBars);
  });
});

describe('chord labels at narrow zoom', () => {
  const room = (chars: number) => CHORD_PAD + chars * CHORD_CHAR_W;

  it('shows the full symbol when it fits', () => {
    expect(chordLabel('F#m7', room(4))).toBe('F#m7');
    expect(chordLabel('C', 200)).toBe('C');
  });

  it('cuts a symbol that does not fit with an ellipsis', () => {
    expect(chordLabel('F#m7', room(3))).toBe('F#…');
    expect(chordLabel('Gsus4', room(2))).toBe('G…');
  });

  it('shows nothing when not even a letter and an ellipsis fit', () => {
    expect(chordLabel('Am', room(1))).toBe('');
    expect(chordLabel('C', room(1))).toBe('C');
    expect(chordLabel('C', 3)).toBe('');
  });
});
