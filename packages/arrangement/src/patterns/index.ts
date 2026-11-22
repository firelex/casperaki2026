// Step 6 — pattern generator orchestration (docs/58i lane dispatch).
//
// Takes the structure (with chords) plus the selection result and returns
// per-segment patterns keyed by LANE display name. For each segment we walk
// its `activeLanes`, look the lane up in the roster, and dispatch to the
// generator for the lane's catalog-family classifier. A family may appear on
// more than one lane (e.g. rock's two electric guitars) — each lane gets its
// own pattern, forked by lane name so duplicate-family lanes diverge.
//
// Determinism: each lane forks `ctx.rng.fork('lane/<laneName>')` before the
// family generator forks its own `patterns/<family>` stream, so reordering or
// adding a lane never shifts another lane's draws.

import { parseChord } from '@casperaki/music-theory';
import type { GeneratorContext } from '../context.js';
import type { Segment, SongStructure } from '@casperaki/song-schema';
import { type InstrumentFamily, type SelectionResult } from '../selection/types.js';
import { generateBassPattern } from './bass.js';
import { generateDrumPattern } from './drums.js';
import { generateGuitarPattern } from './guitar.js';
import { generateKeysPattern } from './keys.js';
import { generateBrassPattern, generateStringsPattern } from './orchestral.js';
import { generatePadPattern } from './pad.js';
import { generatePluckedSynthsPattern, generateSynthsPattern } from './synths.js';
import type { FamilyPattern, PatternResult, SegmentPatterns } from './types.js';

export {
  generateBassPattern,
  generateBrassPattern,
  generateDrumPattern,
  generateGuitarPattern,
  generateKeysPattern,
  generatePadPattern,
  generatePluckedSynthsPattern,
  generateStringsPattern,
  generateSynthsPattern,
};

// Family classifier → its pattern generator. Each generator still takes
// `(ctx, segment, activity)` and self-gates on the family string, so we pass
// a single-element `[family]` activity to drive it for the dispatched lane.
type FamilyGenerator = (
  ctx: GeneratorContext,
  segment: Segment,
  activity: readonly InstrumentFamily[],
) => FamilyPattern | undefined;

const GENERATOR_BY_FAMILY: Readonly<Record<InstrumentFamily, FamilyGenerator>> = {
  drums: generateDrumPattern,
  // Bass is generated in its own pass (with the drum pattern and the song's chord roots).
  bass: () => {
    throw new Error('generatePatterns: bass is generated in pass 2, not through the family table');
  },
  keys: generateKeysPattern,
  pad: generatePadPattern,
  guitar: generateGuitarPattern,
  synths: generateSynthsPattern,
  pluckedSynths: generatePluckedSynthsPattern,
  popStrings: generateStringsPattern,
  popBrass: generateBrassPattern,
};

export function generatePatterns(
  ctx: GeneratorContext,
  structure: SongStructure,
  selection: SelectionResult,
  /** Per-lane pattern variation (sequencer "new pattern"): lane → variation
   *  number. Variation n > 0 forks `lane/<name>#v<n>` instead of `lane/<name>`,
   *  so only that lane's draws change. */
  laneVariants: ReadonlyMap<string, number> = new Map(),
): PatternResult {
  // Every chord root the song uses: the bass decides its octave on them.
  const songChordRoots = new Set(structure.flatMap((seg) => seg.bars.flatMap((bar) => bar.chords.map((c) => parseChord(c).root))));
  const laneFork = (laneName: string): string => {
    const v = laneVariants.get(laneName);
    return v ? `lane/${laneName}#v${v}` : `lane/${laneName}`;
  };
  if (structure.length !== selection.segments.length) {
    throw new Error(
      `generatePatterns: structure has ${structure.length} segments, selection has ${selection.segments.length}`,
    );
  }

  // Lane name → its roster family classifier.
  const familyByLane = new Map<string, InstrumentFamily>(
    selection.instruments.map((s) => [s.lane, s.family]),
  );
  // Lane name → its lowLevel token (docs/62 A6 — the synths generator forces
  // `leadSynthsAnalog` to a fixed style, so it needs the lane's lowLevel which
  // the uniform `(ctx, segment, activity)` generator signature otherwise drops).
  const lowLevelByLane = new Map<string, string>(
    selection.instruments.map((s) => [s.lane, s.lowLevel]),
  );

  const segments: SegmentPatterns[] = structure.map((segment, i) => {
    const activity = selection.segments[i]!;
    if (activity.segmentName !== segment.name) {
      throw new Error(
        `generatePatterns: selection/structure misaligned at index ${i}: "${activity.segmentName}" vs "${segment.name}"`,
      );
    }
    const lanes: Record<string, FamilyPattern> = {};
    // Pass 1 — every non-bass lane. Each lane forks `lane/<name>`, so the
    // generation ORDER never shifts another lane's draws (determinism
    // contract); we generate drums here so bass can read it in pass 2.
    // to-do #2: HipHopBass (urban) derives its line from the drum pattern.
    let drumPattern: FamilyPattern | undefined;
    for (const laneName of activity.activeLanes) {
      const family = familyByLane.get(laneName);
      if (!family || family === 'bass') continue;
      const laneCtx: GeneratorContext = { ...ctx, rng: ctx.rng.fork(laneFork(laneName)) };
      // The synths generator needs the lane's lowLevel to force leadSynthsAnalog
      // (docs/62 A6); every other family uses the uniform 3-arg signature.
      const pattern =
        family === 'synths'
          ? generateSynthsPattern(laneCtx, segment, [family], lowLevelByLane.get(laneName))
          : GENERATOR_BY_FAMILY[family](laneCtx, segment, [family]);
      if (pattern) {
        lanes[laneName] = pattern;
        if (family === 'drums' && !drumPattern) drumPattern = pattern;
      }
    }
    // Pass 2 — bass lane(s), passed the segment's drum pattern (used only by
    // the urban/HipHop generator; ignored by every other genre).
    for (const laneName of activity.activeLanes) {
      if (familyByLane.get(laneName) !== 'bass') continue;
      const laneCtx: GeneratorContext = { ...ctx, rng: ctx.rng.fork(laneFork(laneName)) };
      const pattern = generateBassPattern(laneCtx, segment, ['bass'], drumPattern, songChordRoots);
      if (pattern) lanes[laneName] = pattern;
    }
    return { segmentName: segment.name, lanes };
  });

  return { segments };
}
