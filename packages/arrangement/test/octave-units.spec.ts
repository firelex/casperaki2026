// The legacy wrote pitches as note NAMES (read by the engine with middle C =
// C4 = MIDI 60) on 2-bar templates against C chords, which the engine moved
// to each chord root the nearest way (Note::deltaTo(root, compareRoots)).
// These tests recompute the legacy results for keys / pad / synths.

import { describe, expect, it } from 'vitest';

import { createRng, parseChord } from '@casperaki/music-theory';
import type { Genre } from '@casperaki/song-schema';

import { generateChords, generatePatterns, generateSongStructure, selectInstruments, type GeneratorContext } from '../src/index.js';
import { nearestRootDelta } from '../src/patterns/pad.js';

/** casperaki_engine music/Note.h getMidiNoteNumber: noteNumber + octave * 12 + 12. */
const engineMidi = (name: string) => {
  const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const octave = Number(name.at(-1));
  return NAMES.indexOf(name.slice(0, -1).toUpperCase()) + octave * 12 + 12;
};
/** Note::deltaTo(other, compareRoots = true) from C (midiNote 0). */
const deltaToRoot = (root: number) => {
  let d = root - 0;
  d = d % 12;
  if (d > 6) d -= 12;
  return d;
};

function patternsFor(seed: string, genre: Genre) {
  const ctx: GeneratorContext = { params: { genre, key: 'C', bpm: 120, seed }, rng: createRng(seed) };
  const structure = generateChords(ctx, generateSongStructure(ctx));
  return { structure, patterns: generatePatterns(ctx, structure, selectInstruments(ctx, structure)) };
}

describe('legacy octave units', () => {
  it('moves from C to a chord root the way the engine does', () => {
    for (let r = 0; r < 12; r++) expect(nearestRootDelta(r)).toBe(deltaToRoot(r));
  });

  it('pad single notes: the C template at octave 5 / 4 / 3, moved to the root (ChordsAndNotesPadPatternGeneratorClass.js:61-73)', () => {
    let checked = 0;
    for (let i = 0; i < 40; i++) {
      const { structure, patterns } = patternsFor(`pad-units-${i}`, 'brightPop');
      const byName = new Map(structure.map((s) => [s.name, s]));
      for (const seg of patterns.segments) {
        seg.lanes.Pad?.bars.forEach((bar, b) => {
          for (const ev of bar.notes['0.0'] ?? []) {
            if (ev.type !== 'note') continue;
            const root = parseChord(byName.get(seg.segmentName)!.bars[b]!.chords[0]!).root;
            const legacy = ['C5', 'C4', 'C3'].map((n) => engineMidi(n) + deltaToRoot(root));
            expect(legacy).toContain(ev.note);
            checked++;
          }
        });
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('keys chords carry the hand voicing the legacy gave them (pianoLeftHand / pianoRightHand)', () => {
    let chords = 0;
    for (const genre of ['brightPop', 'ballad', 'edm', 'schlager', 'rock', 'latin'] as Genre[]) {
      for (let i = 0; i < 6; i++) {
        const { patterns } = patternsFor(`keys-hand-${genre}-${i}`, genre);
        for (const seg of patterns.segments) {
          for (const bar of seg.lanes.Keys?.bars ?? []) {
            for (const evs of Object.values(bar.notes)) {
              for (const ev of evs) {
                if (ev.type !== 'chord') continue;
                expect(['pianoLeftHand', 'pianoRightHand']).toContain(ev.chordType);
                chords++;
              }
            }
          }
        }
      }
    }
    expect(chords).toBeGreaterThan(0);
  });

  it('playful lead synths send the legacy chord walk, not a distance from middle C', () => {
    let walks = 0;
    // Styles whose synth pool is only 'playful'.
    for (const genre of ['ballad', 'rock', 'urban'] as Genre[]) {
      for (let i = 0; i < 4; i++) {
        const { patterns } = patternsFor(`playful-${genre}-${i}`, genre);
        for (const seg of patterns.segments) {
          for (const bar of seg.lanes.Synths?.bars ?? []) {
            for (const evs of Object.values(bar.notes)) {
              for (const ev of evs) {
                if (ev.type !== 'noteRelative' || ev.distanceFromMiddleC !== undefined) continue;
                expect([4, 5]).toContain(ev.octave);
                expect(ev.direction).toBe('center');
                expect(ev.note).toBeGreaterThanOrEqual(0);
                expect(ev.note).toBeLessThanOrEqual(4);
                expect([-1, 0, 1]).toContain(ev.offset);
                walks++;
              }
            }
          }
        }
      }
    }
    expect(walks).toBeGreaterThan(0);
  });
});
