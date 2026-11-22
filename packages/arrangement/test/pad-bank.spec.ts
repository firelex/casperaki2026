// Step 13 — legacy-derived pad pattern bank tests.
//
// Pins the pad bank manifest invariants, the selection determinism
// contract, per-genre coverage, and the chord-aware lowering from the
// legacy ChordsAndNotesPadPatternGeneratorClass.createPadPattern
// 9 voicing styles. See docs/53x.

import { describe, expect, it } from 'vitest';

import {
  beatsPerBar,
  createRng,
  formatBarBeat,
  parseBarBeat,
  parseChord,
  type Rng,
} from '@casperaki/music-theory';
import {
  ChordSymbolSchema,
  GenreSchema,
  MidiNoteSchema,
  stableStringify,
  type Genre,
} from '@casperaki/song-schema';

import {
  DataAssetError,
  describePadBank,
  generateChords,
  generatePadPattern,
  generatePatterns,
  generateSongStructure,
  selectInstruments,
  selectPadStyle,
  type FamilyPattern,
  type GenerateParams,
  type GeneratorContext,
} from '../src/index.js';
import { _resetPadBankCache } from '../src/patterns/pad-bank.js';

const ALL_LEGACY_STYLES = [
  'chordsOneOctaveHigh',
  'chordsOneOctaveMid',
  'chordsOneOctaveLow',
  'chordsTwoOctavesHigh',
  'chordsTwoOctavesMid',
  'chordsTwoOctavesLow',
  'singleNoteHigh',
  'singleNoteMid',
  'singleNoteLow',
];

function makeCtx(seed: string | number, genre: Genre = 'brightPop'): GeneratorContext {
  const params: GenerateParams = { genre, key: 'C', bpm: 120, seed };
  return { rng: createRng(seed), params };
}

function freshPadRng(seed: string | number): Rng {
  return createRng(seed).fork('patterns/pad');
}

describe('pad bank manifest', () => {
  it('declares all 9 legacy voicing styles', () => {
    const bank = describePadBank();
    expect(Object.keys(bank.styles).sort()).toEqual([...ALL_LEGACY_STYLES].sort());
  });

  it('declares the legacy whole-bar shape (barBeats=4, barDuration=4)', () => {
    const bank = describePadBank();
    expect(bank.barBeats).toBe(4);
    expect(bank.barDuration).toBe(4);
  });

  it('maps every canonical brain genre to at least one pad style', () => {
    const bank = describePadBank();
    for (const g of GenreSchema.options) {
      expect(bank.genreStyles[g], `genre "${g}" missing pad style mapping`).toBeDefined();
      expect(bank.genreStyles[g]!.length).toBeGreaterThan(0);
    }
  });

  it('every chord-style declares a legacy voicing tag; every singleNote-style declares an octave', () => {
    const bank = describePadBank();
    for (const [name, style] of Object.entries(bank.styles)) {
      if (style.kind === 'chord') {
        expect(style.voicing, `style ${name} missing voicing`).toBeDefined();
      } else {
        expect(style.templateOctave, `style ${name} missing octave`).toBeDefined();
      }
    }
  });

  it('selector throws DataAssetError on a non-canonical genre name', () => {
    const rng = freshPadRng('any');
    expect(() => selectPadStyle(rng, 'pop')).toThrow(DataAssetError);
    expect(() => selectPadStyle(rng, 'jazz')).toThrow(DataAssetError);
  });

  it('cache reset re-reads disk without changing semantics', () => {
    const before = describePadBank();
    _resetPadBankCache();
    const after = describePadBank();
    expect(after).toEqual(before);
  });
});

describe('selectPadStyle determinism', () => {
  it('same seed → same style (a contract the goldens depend on)', () => {
    const a = selectPadStyle(freshPadRng('repro-seed'), 'brightPop');
    const b = selectPadStyle(freshPadRng('repro-seed'), 'brightPop');
    expect(a.styleName).toBe(b.styleName);
    expect(a.style).toEqual(b.style);
  });

  it('different seeds → distinct picks across 16 trials for brightPop (mapped to >1 style)', () => {
    const seeds = Array.from({ length: 16 }, (_, i) => `pad-seed-${i}`);
    const picks = new Set(
      seeds.map((s) => selectPadStyle(freshPadRng(s), 'brightPop').styleName),
    );
    expect(picks.size).toBeGreaterThan(1);
  });
});

describe('generatePadPattern × per-genre coverage', () => {
  const SYNTHETIC_SEGMENT = {
    name: 'chorus1',
    bars: [
      { chords: ['C', 'G', 'Am', 'F'] },
      { chords: ['C', 'G', 'Am', 'F'] },
      { chords: ['F', 'C', 'G', 'G'] },
      { chords: ['Am', 'F', 'C', 'G'] },
    ],
  };
  for (const genre of GenreSchema.options) {
    it(`emits a non-empty pad pattern for genre "${genre}"`, () => {
      const ctx = makeCtx(`${genre}-coverage`, genre);
      const result = generatePadPattern(
        ctx,
        SYNTHETIC_SEGMENT as never,
        ['pad'] as never,
      );
      expect(result).toBeDefined();
      let events = 0;
      for (const bar of result!.bars) {
        for (const evs of Object.values(bar.notes)) events += evs.length;
      }
      expect(events).toBe(SYNTHETIC_SEGMENT.bars.length);
    });
  }

  it('end-to-end brightPop pipeline emits pad events for every pad-active segment', () => {
    const ctx = makeCtx('end-to-end-pad');
    const structure = generateChords(ctx, generateSongStructure(ctx));
    const selection = selectInstruments(ctx, structure);
    const patterns = generatePatterns(ctx, structure, selection);
    let padActive = 0;
    let padEvents = 0;
    for (const segment of patterns.segments) {
      const pad = segment.lanes.Pad;
      if (!pad) continue;
      padActive++;
      for (const bar of pad.bars) {
        for (const evs of Object.values(bar.notes)) padEvents += evs.length;
      }
    }
    expect(padActive).toBeGreaterThan(0);
    expect(padEvents).toBe(padActive *
      patterns.segments.reduce((n, s) => {
        const pad = s.lanes.Pad;
        return pad ? n + pad.bars.length : n;
      }, 0) / padActive);
  });
});

describe('generatePadPattern invariants', () => {
  function padFor(seed: string | number): {
    structure: ReturnType<typeof generateSongStructure>;
    patterns: ReturnType<typeof generatePatterns>;
  } {
    const ctx = makeCtx(seed);
    const structure = generateChords(ctx, generateSongStructure(ctx));
    const selection = selectInstruments(ctx, structure);
    const patterns = generatePatterns(ctx, structure, selection);
    return { structure, patterns };
  }

  it('every pad bar emits exactly one hit, at beat 0, with full-bar duration', () => {
    const { patterns } = padFor('pad-shape');
    let bars = 0;
    for (const segment of patterns.segments) {
      const pad = segment.lanes.Pad;
      if (!pad) continue;
      for (const bar of pad.bars) {
        const keys = Object.keys(bar.notes);
        expect(keys).toEqual(['0.0']);
        const events = bar.notes['0.0']!;
        expect(events.length).toBe(1);
        const ev = events[0]!;
        if (ev.type === 'chord') {
          expect(ev.duration).toBe(4);
        } else if (ev.type === 'note') {
          expect(ev.duration).toBe(4);
        }
        bars++;
      }
    }
    expect(bars).toBeGreaterThan(0);
  });

  it('every BarBeat key is in [0, beatsPerBar())', () => {
    const beats = beatsPerBar();
    for (const seed of ['pb-1', 'pb-2', 'pb-3']) {
      const { patterns } = padFor(seed);
      for (const segment of patterns.segments) {
        const pad = segment.lanes.Pad;
        if (!pad) continue;
        for (const bar of pad.bars) {
          for (const key of Object.keys(bar.notes)) {
            const b = parseBarBeat(key);
            expect(b).toBeGreaterThanOrEqual(0);
            expect(b).toBeLessThan(beats);
          }
        }
      }
    }
  });

  it('pad bar count matches structure bar count for every pad-active segment', () => {
    const { structure, patterns } = padFor('pad-bar-alignment');
    const byName = new Map(structure.map((s) => [s.name, s.bars.length]));
    for (const segment of patterns.segments) {
      const pad = segment.lanes.Pad;
      if (!pad) continue;
      expect(pad.bars.length).toBe(byName.get(segment.segmentName));
    }
  });

  it("chord-style events carry the bar's first chord; singleNote-style events lower to chord root in the style's octave", () => {
    const { structure, patterns } = padFor('pad-chord-relation');
    const byName = new Map(structure.map((s) => [s.name, s]));
    let inspected = 0;
    for (const segment of patterns.segments) {
      const pad = segment.lanes.Pad;
      if (!pad) continue;
      const struct = byName.get(segment.segmentName)!;
      pad.bars.forEach((bar, barIdx) => {
        const events = bar.notes['0.0']!;
        const ev = events[0]!;
        const expectedChord = struct.bars[barIdx]!.chords[0]!;
        if (ev.type === 'chord') {
          expect(ChordSymbolSchema.safeParse(ev.chord).success).toBe(true);
          expect(ev.chord).toBe(expectedChord);
        } else {
          if (ev.type !== 'note') return;
          expect(MidiNoteSchema.safeParse(ev.note).success).toBe(true);
          const expectedRoot = parseChord(expectedChord).root;
          const pitch = ev.note as number;
          expect(((pitch - expectedRoot) % 12 + 12) % 12).toBe(0);
          // Legacy register: 'C' + 5/4/3 (MIDI 72/60/48) moved to the root the
          // nearest way (-5..+6), so within [template - 5, template + 6].
          const templates = [72, 60, 48];
          expect(templates.some((t) => pitch - t >= -5 && pitch - t <= 6)).toBe(true);
        }
        inspected++;
      });
    }
    expect(inspected).toBeGreaterThan(0);
  });

  it("chord-style events carry the selected voicing as `chordType` (to-do #6)", () => {
    // Every pad-active segment picks one style; chord styles must stamp the
    // bank's voicing tag onto each emitted chord event (legacy
    // `_addChord(0, chord, chordType, 4)`). singleNote styles emit no chordType.
    const VOICINGS = new Set([
      'oneOctaveHigh', 'oneOctaveMid', 'oneOctaveLow',
      'twoOctavesHigh', 'twoOctavesMid', 'twoOctavesLow',
    ]);
    let chordEvents = 0;
    for (const seed of ['voicing-1', 'voicing-2', 'voicing-3', 'voicing-4', 'voicing-5']) {
      const ctx = makeCtx(seed);
      const structure = generateChords(ctx, generateSongStructure(ctx));
      const selection = selectInstruments(ctx, structure);
      const patterns = generatePatterns(ctx, structure, selection);
      for (const segment of patterns.segments) {
        const pad = segment.lanes.Pad;
        if (!pad) continue;
        // One voicing per segment — collect the distinct chordType values.
        const tags = new Set<string | undefined>();
        for (const bar of pad.bars) {
          for (const ev of bar.notes['0.0'] ?? []) {
            if (ev.type === 'chord') {
              expect(ev.chordType, 'chord event missing chordType').toBeDefined();
              expect(VOICINGS.has(ev.chordType as string)).toBe(true);
              tags.add(ev.chordType);
              chordEvents++;
            } else if (ev.type === 'note') {
              // singleNote style — no voicing tag.
              expect((ev as { chordType?: unknown }).chordType).toBeUndefined();
            }
          }
        }
        // A chord-style segment uses a single voicing across all its bars.
        expect(tags.size).toBeLessThanOrEqual(1);
      }
    }
    expect(chordEvents).toBeGreaterThan(0);
  });

  it('emitted BarBeat keys are normalised via formatBarBeat', () => {
    const { patterns } = padFor('format-check');
    for (const segment of patterns.segments) {
      const pad = segment.lanes.Pad;
      if (!pad) continue;
      for (const bar of pad.bars) {
        for (const key of Object.keys(bar.notes)) {
          expect(key).toBe(formatBarBeat(parseBarBeat(key)));
        }
      }
    }
  });

  it('same seed → byte-identical pad content (canary against hidden Math.random use)', () => {
    function padBytes(seed: string): string {
      const { patterns } = padFor(seed);
      const onlyPad: Record<string, FamilyPattern> = {};
      for (const segment of patterns.segments) {
        if (segment.lanes.Pad) onlyPad[segment.segmentName] = segment.lanes.Pad;
      }
      return stableStringify(onlyPad, 2);
    }
    expect(padBytes('determinism-A')).toBe(padBytes('determinism-A'));
  });

  it('different seeds → different pad style choices (across the genres that map to >1 style)', () => {
    const seeds = ['ps-1', 'ps-2', 'ps-3', 'ps-4', 'ps-5', 'ps-6', 'ps-7', 'ps-8'];
    const picks = new Set(
      seeds.map((s) => selectPadStyle(freshPadRng(s), 'brightPop').styleName),
    );
    expect(picks.size).toBeGreaterThan(1);
  });

  it('does not mutate the input structure', () => {
    const ctx = makeCtx('immutability-pad');
    const structure = generateChords(ctx, generateSongStructure(ctx));
    const before = stableStringify(structure, 2);
    const selection = selectInstruments(ctx, structure);
    generatePatterns(ctx, structure, selection);
    expect(stableStringify(structure, 2)).toBe(before);
  });
});

describe('cross-family fork-salt independence (drums/bass goldens stay byte-stable)', () => {
  // The pad generator forks `patterns/pad`. Drum and bass streams stay
  // untouched. Reproduce step-10 / step-11 invariants for the canonical
  // seed exactly.
  it('step-10 drum invariant for the canonical seed still holds', () => {
    const ctx = makeCtx('brightPop-vertical-slice');
    const structure = generateChords(ctx, generateSongStructure(ctx));
    const selection = selectInstruments(ctx, structure);
    const patterns = generatePatterns(ctx, structure, selection);
    const chorus = patterns.segments.find((s) => s.segmentName === 'chorus1')!;
    const drums = chorus.lanes.Drums!;
    expect(drums).toBeDefined();
    const bar0 = drums.bars[0]!;
    const at = (k: string): number[] =>
      (bar0.notes[k] ?? [])
        .filter((e) => e.type === 'note')
        .map((e) => (e.type === 'note' ? (e.note as number) : -1));
    // popTight algo invariant (docs/58): bassDrum1 (36) on beats 1 & 3
    // (0.0, 2.0), snareDrum1 (38) on beats 2 & 4 (1.0, 3.0), clap (39)
    // on the & of beat 4 (3.5), closed-hat (42) on the offbeats.
    expect(at('0.0')).toContain(36);
    expect(at('2.0')).toContain(36);
    expect(at('1.0')).toContain(38);
    expect(at('3.0')).toContain(38);
    expect(at('3.5')).toContain(39);
    expect(at('0.5')).toContain(42);
  });
});
