// to-do #1 — per-segment drum + bass override primitives (Phase A).
//
// Legacy fires per-segment overrides that either MASK the drum pattern (keep
// only some pieces) or REPLACE it with a synthesized one. The C++ engine
// (casperaki_engine/Source/instruments/Drums.h) already implements the 8 mask
// types — BUT only on the `override.type` (non-reset) path, which masks the
// BASE pattern. The rebuild delivers each segment's pattern through the
// `reset` path (override.pattern replaces the base, Drums.h:329-333), which
// bypasses the engine mask. So the rebuild bakes the mask into the brain's
// emitted per-segment pattern instead — this module is that bake-in, mirroring
// the engine's exact piece predicates (Drums.h:165-186) so the audible result
// is identical.
//
// Phase A = the pure primitives (masks + synthesized floor patterns + bass
// onTheBeat descriptors). Phase B layers the cross-segment scratchpad state
// machine (drums.js:218-501) that decides which override fires per segment and
// wires emission into orchestrate.

import { parseChord, type Rng } from '@casperaki/music-theory';
import { nearestRootDelta } from '../patterns/pad.js';
import { MidiNoteSchema, type Segment, type SongStructure } from '@casperaki/song-schema';

import type { GeneratorContext } from '../context.js';
import { describeDrumBank } from '../patterns/drums-bank.js';
import { drumStylesFor, generateDrumPattern } from '../patterns/drums.js';
import { bassPreviewFromParams, drumPreviewFromParams } from '../patterns/proposals.js';
import { addNoteEvent, emptyBarPattern } from '../patterns/shared.js';
import type { BarPattern, FamilyPattern, PatternResult } from '../patterns/types.js';
import type { InstrumentFamily, SelectionResult } from '../selection/types.js';
import { segmentType } from './segment-type.js';

// ---------------------------------------------------------------------------
// Drum masks
// ---------------------------------------------------------------------------

/** The 8 engine mask types (Drums.h `getOverrideTypeFromString`). */
export type DrumMaskType =
  | 'bassDrumOnly'
  | 'noBassDrum'
  | 'bassDrumAndSnareDrumOnly'
  | 'hiHatOnly'
  | 'bassDrumAndHiHatOnly'
  | 'bassDrumSnareDrumAndHiHatOnly'
  | 'percussionOnly'
  | 'noPercussion';

// MIDI → drum piece name, inverted from the canonical drum bank. When two
// pieces share a MIDI (e.g. hiHatClosed2 / hiHatPedal both 44) either name maps
// to the same predicate result, so first-seen is fine.
let midiToPiece: ReadonlyMap<number, string> | undefined;
function pieceNameForMidi(midi: number): string | undefined {
  if (!midiToPiece) {
    const map = new Map<number, string>();
    for (const [name, m] of Object.entries(describeDrumBank().lanes)) {
      if (!map.has(m)) map.set(m, name);
    }
    midiToPiece = map;
  }
  return midiToPiece.get(midi);
}

// Engine piece predicates (Drums.h:165-186) — kept byte-faithful.
const isBassDrums = (n: string): boolean => n.startsWith('bassDrum');
const isHiHat = (n: string): boolean => n.startsWith('hiHat');
const isSnareDrum = (n: string): boolean => n.startsWith('snareDrum');
const isPercussion = (n: string): boolean =>
  !(
    n.startsWith('hiHat') ||
    n.startsWith('crash') ||
    n === 'ride' ||
    n === 'clap' ||
    n === 'snap' ||
    n === 'shaker'
  );

/** Whether `pieceName` survives `type`'s mask (engine `applyPattern` switch). */
function keepsPiece(type: DrumMaskType, n: string): boolean {
  switch (type) {
    case 'bassDrumOnly':
      return isBassDrums(n);
    case 'noBassDrum':
      return !isBassDrums(n);
    case 'bassDrumAndSnareDrumOnly':
      return isBassDrums(n) || isSnareDrum(n);
    case 'hiHatOnly':
      return isHiHat(n);
    case 'bassDrumAndHiHatOnly':
      return isBassDrums(n) || isHiHat(n);
    case 'bassDrumSnareDrumAndHiHatOnly':
      return isBassDrums(n) || isHiHat(n) || isSnareDrum(n);
    case 'percussionOnly':
      return isPercussion(n);
    case 'noPercussion':
      return !isPercussion(n);
  }
}

/**
 * Apply a drum mask to an already-emitted per-segment drum pattern, dropping
 * every note whose piece the mask excludes. Non-note events and notes with an
 * unknown MIDI are kept (defensive). Returns a fresh BarPattern[] — the input
 * is not mutated.
 */
export function applyDrumOverrideMask(
  bars: readonly BarPattern[],
  type: DrumMaskType,
): BarPattern[] {
  return bars.map((bar) => {
    const out = emptyBarPattern();
    for (const [key, events] of Object.entries(bar.notes)) {
      if (!events) continue;
      const beat = Number.parseFloat(key);
      for (const e of events) {
        const drop =
          e.type === 'note' &&
          typeof e.note === 'number' &&
          pieceNameForMidi(e.note) !== undefined &&
          !keepsPiece(type, pieceNameForMidi(e.note)!);
        if (!drop) addNoteEvent(out, beat, e);
      }
    }
    return out;
  });
}

/** Test-only — drop the memoised MIDI→piece map. */
export function _resetOverrideMidiMap(): void {
  midiToPiece = undefined;
}

// ---------------------------------------------------------------------------
// Synthesized floor replacements (OverrideGeneratorClass.js, drums)
// ---------------------------------------------------------------------------

const BASS_DRUM_1_MIDI = 36;
const CLAP_MIDI = 39;

/** Where a floor override applies within the segment. */
export type OverrideScope = 'whole' | 'secondHalf' | 'lastBar';

/**
 * Synthesize a one-/four-on-the-floor bass-drum pattern over `barCount` bars.
 * `kicksPerBar` is 1 (one-on-the-floor, beat 0) or 4 (four-on-the-floor, every
 * beat); `withClap` layers a hand-clap on every kick (the `...AndHandClap`
 * variants). `scope` restricts it to the whole segment, its second half, or
 * its last bar (legacy startHit windows, OverrideGeneratorClass.js:33-92).
 */
export function synthesizeFloorPattern(
  barCount: number,
  kicksPerBar: 1 | 4,
  withClap: boolean,
  scope: OverrideScope,
): BarPattern[] {
  const bars: BarPattern[] = Array.from({ length: barCount }, () => emptyBarPattern());
  const startBar =
    scope === 'whole' ? 0 : scope === 'secondHalf' ? Math.floor(barCount / 2) : barCount - 1;
  const beats = kicksPerBar === 1 ? [0] : [0, 1, 2, 3];
  for (let bar = Math.max(0, startBar); bar < barCount; bar++) {
    for (const beat of beats) {
      addNoteEvent(bars[bar]!, beat, { type: 'note', note: MidiNoteSchema.parse(BASS_DRUM_1_MIDI) });
      if (withClap) {
        addNoteEvent(bars[bar]!, beat, { type: 'note', note: MidiNoteSchema.parse(CLAP_MIDI) });
      }
    }
  }
  return bars;
}

// ---------------------------------------------------------------------------
// Bass overrides (bassPatterns/OverrideGeneratorClass.js)
// ---------------------------------------------------------------------------

/** The two legacy bass override types. */
export type BassOverrideType = 'onTheBeat15' | 'onTheBeat157';

/**
 * The legacy bass override note descriptor: `[hit, hitLength]` pairs over a
 * 2-bar (8-beat) window, played on the chord root at octave 2 (the caller
 * resolves the chord, like the SimpleBass generator). `onTheBeat15` = whole
 * notes on beats 1 and 5; `onTheBeat157` = beat 1 (whole) + beats 5 and 7
 * (half). reset/replace.
 */
export function bassOverrideNotes(type: BassOverrideType): readonly (readonly [number, number])[] {
  switch (type) {
    case 'onTheBeat15':
      return [
        [0, 4],
        [4, 4],
      ];
    case 'onTheBeat157':
      return [
        [0, 4],
        [4, 2],
        [6, 2],
      ];
  }
}

// ---------------------------------------------------------------------------
// Phase B — cross-segment override scratchpad state machine + apply step
// ---------------------------------------------------------------------------
//
// Ports the OVERRIDE half of the legacy per-segment loops
// (`arrangements/instruments/drums.js:202-690` + `bass.js:67-187`). The fill /
// mute / signal-processor halves of those loops are already ported as separate
// modules (`fills.ts` / `mutes.ts` (dead-code stub) / `signal-processors.ts`),
// and `segmentFunction` in the legacy loop only feeds the *fill* carry-over —
// so the override-only subset reduces to: which override fires per segment, the
// cross-segment scratchpad carry, the verse mutation, dropOut, and (drums) the
// per-song flags + the splice pool.
//
// Apply model (resolved 06-16, see docs/06-16-2026-to-dos.md #1): the rebuild
// delivers each segment's pattern through the engine's `reset` path, which
// bypasses the engine's own mask branch — so we BAKE the override into the
// brain's emitted per-segment pattern. Mask overrides filter the base pattern
// (`applyDrumOverrideMask`); floor / secondary / bass overrides REPLACE it.

/** The override that fires for one segment's Drums lane. */
export type DrumOverrideDecision =
  | { readonly kind: 'none' }
  | { readonly kind: 'mask'; readonly maskType: DrumMaskType }
  | { readonly kind: 'floor'; readonly kicksPerBar: 1 | 4; readonly withClap: boolean }
  | { readonly kind: 'secondary' }
  | { readonly kind: 'dropOut' };

// Legacy genre → drum-pattern STYLE (config.json#defaultStyleMappings.
// drumPatterns). Every canonical rebuild genre maps to a single style, so the
// `Tools.selectRandomly` over a 1-element array is deterministic — we resolve
// it directly. The override branches gate on this legacy style string (NOT the
// rebuild's internal drum-bank style names like `popTightAlgo`).
const LEGACY_DRUM_STYLE: Readonly<Record<string, string>> = {
  ballad: 'ballad',
  edm: 'edm',
  latin: 'latin',
  brightPop: 'brightPop',
  organicVibes: 'organicVibes',
  rock: 'rock',
  schlager: 'edm',
  urban: 'urban',
};

const FLOOR_OVERRIDES: ReadonlySet<string> = new Set([
  'oneOnTheFloorBassDrum',
  'oneOnTheFloorBassDrumAndHandClap',
  'fourOnTheFloorBassDrum',
  'fourOnTheFloorBassDrumAndHandClap',
]);

const MASK_TYPES: ReadonlySet<string> = new Set<DrumMaskType>([
  'bassDrumOnly',
  'noBassDrum',
  'bassDrumAndSnareDrumOnly',
  'hiHatOnly',
  'bassDrumAndHiHatOnly',
  'bassDrumSnareDrumAndHiHatOnly',
  'percussionOnly',
  'noPercussion',
]);

/** Map a legacy override string (or `undefined` = empty) to a decision. */
function overrideStringToDecision(override: string | undefined): DrumOverrideDecision {
  if (override === undefined || override === '') return { kind: 'none' };
  if (override === 'secondaryPattern') return { kind: 'secondary' };
  if (FLOOR_OVERRIDES.has(override)) {
    return {
      kind: 'floor',
      kicksPerBar: override.startsWith('four') ? 4 : 1,
      withClap: /handClap/i.test(override),
    };
  }
  if (MASK_TYPES.has(override)) return { kind: 'mask', maskType: override as DrumMaskType };
  // Pool exhaustion can leave `override` set to a non-mask/floor token in
  // legacy (getOverride(undefined) → {type:undefined}); treat as no-op.
  return { kind: 'none' };
}

// Scratchpad per segment-type. `overrideType`: a string = the carried override;
// `''` = legacy `{}` (saved-but-empty, regenerates on carry); `undefined` =
// not-yet-saved or cleared by the "only" exclusion. The string/''/undefined
// trichotomy mirrors legacy's `overrideDetails` object / {} / undefined exactly.
const SAVED_EMPTY = '';

/**
 * Decide the Drums override for every segment (port of `drums.js`'s override
 * half). Deterministic in `rng` — the caller forks
 * `ctx.rng.fork('arrangement-polish/drum-overrides')`. `genre` resolves the
 * legacy drum style the branches gate on.
 */
export function decideDrumOverrides(
  rng: Rng,
  structure: SongStructure,
  genre: string,
): Record<string, DrumOverrideDecision> {
  const style = LEGACY_DRUM_STYLE[genre] ?? genre;
  const decisions: Record<string, DrumOverrideDecision> = {};

  // Per-song state (drums.js:218-230).
  let dropOut: string | false = false;
  if (rng.pick([false, false, false, false, true])) {
    dropOut = rng.pick(['intro', 'verse', 'break', 'outro']);
  }
  let simplifiedBassDrumUsed = false;
  let hiHatOrPercUsed = false;
  // Mutable per-song pool — `splice` permanently consumes an entry per use
  // (drums.js:480), so the same mask can't recur across the song.
  const pool = [
    'noBassDrum',
    'bassDrumOnly',
    'bassDrumAndSnareDrumOnly',
    'hiHatOnly',
    'percussionOnly',
  ];
  const scratch: Record<string, { overrideType?: string }> = {};

  for (let idx = 0; idx < structure.length; idx++) {
    const segName = structure[idx]!.name;
    const segType = segmentType(segName);

    let override: string | undefined; // legacy `override` — set only on generation; drives flags
    let overrideType: string | undefined; // legacy `overrideDetails` (string form); undefined = empty {}

    const sp = scratch[segType];
    const canCarry =
      sp !== undefined &&
      Object.keys(sp).length > 0 &&
      segName !== 'intro' &&
      segName !== 'outro' &&
      segType !== 'break' &&
      segType !== 'bridge' &&
      !segName.includes('1');

    if (canCarry) {
      const carried = sp!.overrideType;
      // The "only" patterns never carry — clear them so the segment regenerates
      // (drums.js:296-304).
      if (carried !== 'hiHatOnly' && carried !== 'percussionOnly' && carried !== 'bassDrumOnly') {
        overrideType = carried === SAVED_EMPTY ? undefined : carried;
      } else {
        sp!.overrideType = undefined;
      }

      // Verse mutation (drums.js:306-331). NOTE: faithful to the legacy code,
      // NOT its comment — the "only" exclusion above already cleared a
      // `bassDrumOnly` scratch to undefined, so the documented bassDrumOnly →
      // bassDrumAndHiHatOnly path never fires; only bassDrumAndSnareDrumOnly
      // mutates (→ ...AndHiHatOnly) and noBassDrum resets to empty.
      const spType = sp!.overrideType;
      if (
        segType === 'verse' &&
        spType !== undefined &&
        spType !== SAVED_EMPTY &&
        (spType === 'bassDrumOnly' ||
          spType === 'bassDrumAndSnareDrumOnly' ||
          spType === 'noBassDrum')
      ) {
        if (
          segName.includes('2') ||
          (structure.length === 3 && segName.includes('3')) ||
          segName.includes('4')
        ) {
          if (spType === 'bassDrumOnly') overrideType = 'bassDrumAndHiHatOnly';
          else if (spType === 'bassDrumAndSnareDrumOnly')
            overrideType = 'bassDrumSnareDrumAndHiHatOnly';
          else overrideType = undefined; // noBassDrum → {} → regenerate
        }
      }
    } else {
      scratch[segType] = {};
    }

    // Generation (drums.js:365-495) — only when no override was carried.
    if (overrideType === undefined) {
      if (segType === 'break') {
        if (rng.pick([false, true])) {
          const breakOverrides = ['hiHatOnly', 'percussionOnly'];
          if (['edm', 'latin', 'brightPop', 'organicVibes', 'schlager'].includes(style)) {
            breakOverrides.push('fourOnTheFloorBassDrum', 'fourOnTheFloorBassDrumAndHandClap');
          }
          override = rng.pick(breakOverrides);
          overrideType = override;
        }
      } else if (['intro', 'verse', 'preChorus', 'bridge', 'outro'].includes(segType)) {
        // Legacy `Tools.selectRandomly([true])` — always true (kept as a
        // documentary draw-free branch; no rng consumed since pick([true]) is
        // constant).
        let useSecondary = false;
        if (segType === 'bridge') useSecondary = rng.pick([false, true]);

        if (useSecondary) {
          // Legacy rolls busyness 1/2/3 then regenerates a full pattern; the
          // rebuild drum bank has no busyness, so the apply step regenerates a
          // fresh blueprint via a segment-salted fork. Consume one draw to
          // mirror the legacy roll position.
          rng.pick(['1', '2', '3']);
          overrideType = 'secondaryPattern';
        } else if (
          ['edm', 'latin', 'brightPop', 'organicVibes', 'schlager'].includes(style) &&
          segType === 'bridge' &&
          !simplifiedBassDrumUsed &&
          rng.pick([false, false, true])
        ) {
          const ov = ['fourOnTheFloorBassDrum', 'fourOnTheFloorBassDrumAndHandClap'];
          if (['edm', 'latin', 'brightPop', 'schlager'].includes(style)) {
            ov.push('oneOnTheFloorBassDrum', 'oneOnTheFloorBassDrumAndHandClap');
          }
          override = rng.pick(ov);
          overrideType = override;
        } else if (
          ['edm', 'brightPop', 'schlager'].includes(style) &&
          (segType === 'verse' || segType === 'preChorus') &&
          !simplifiedBassDrumUsed &&
          rng.pick([false, false, false, true])
        ) {
          override = rng.pick(['fourOnTheFloorBassDrum', 'fourOnTheFloorBassDrumAndHandClap']);
          overrideType = override;
        } else {
          // Default: splice a mask from the per-song pool, re-rolling hiHat/perc
          // once already used (drums.js:479-483). Pool exhaustion → no override.
          do {
            if (pool.length === 0) {
              override = undefined;
              break;
            }
            override = pool.splice(rng.int(0, pool.length - 1), 1)[0];
          } while ((override === 'hiHatOnly' || override === 'percussionOnly') && hiHatOrPercUsed);
          overrideType = override;
        }
      }
    }

    // Save the override into the scratchpad (drums.js:497-501) BEFORE the
    // dropOut gate — a dropped-out first segment still seeds its type's carry.
    if (scratch[segType]!.overrideType === undefined) {
      scratch[segType]!.overrideType = overrideType === undefined ? SAVED_EMPTY : overrideType;
    }

    // dropOut gate (drums.js:650-686): the chosen segment-type's FIRST instance
    // (intro / outro / *1) is silenced and its flags are NOT updated.
    const dropped =
      dropOut !== false &&
      segType === dropOut &&
      (segName === 'intro' || segName === 'outro' || segName.includes('1'));

    if (!dropped) {
      if (['intro', 'verse', 'preChorus', 'bridge', 'outro'].includes(segType)) {
        if (override !== undefined && FLOOR_OVERRIDES.has(override)) simplifiedBassDrumUsed = true;
        if (override === 'hiHatOnly' || override === 'percussionOnly') hiHatOrPercUsed = true;
      }
      decisions[segName] = overrideStringToDecision(overrideType);
    } else {
      decisions[segName] = { kind: 'dropOut' };
    }
  }

  return decisions;
}

/**
 * Decide the Bass override for every segment (port of `bass.js`'s override
 * half). 1-in-2 chance on verse/preChorus/break/bridge/outro, carried across
 * same-type non-first segments. No dropOut, no flags, no style gate. Returns
 * the override type per segment (or `undefined` = keep the base bass line).
 */
export function decideBassOverrides(
  rng: Rng,
  structure: SongStructure,
): Record<string, BassOverrideType | undefined> {
  const decisions: Record<string, BassOverrideType | undefined> = {};
  const pool: readonly BassOverrideType[] = ['onTheBeat15', 'onTheBeat157'];
  const scratch: Record<string, { overrideType?: BassOverrideType }> = {};

  for (const segment of structure) {
    const segName = segment.name;
    const segType = segmentType(segName);
    let overrideType: BassOverrideType | undefined;

    const sp = scratch[segType];
    if (
      sp !== undefined &&
      segName !== 'intro' &&
      segName !== 'outro' &&
      segName !== 'break' &&
      !segName.includes('1')
    ) {
      overrideType = sp.overrideType; // carry (may be undefined)
    } else {
      scratch[segType] = {};
      if (['verse', 'preChorus', 'break', 'bridge', 'outro'].includes(segType)) {
        if (rng.pick([false, true])) {
          overrideType = rng.pick(pool);
          scratch[segType]!.overrideType = overrideType;
        }
      }
    }

    decisions[segName] = overrideType;
  }

  return decisions;
}

// ---------------------------------------------------------------------------
// Apply step
// ---------------------------------------------------------------------------

const OVERRIDE_BASS_OCTAVE = 2;

function laneForFamily(selection: SelectionResult, family: InstrumentFamily): string | undefined {
  return selection.instruments.find((s) => s.family === family)?.lane;
}

/**
 * Materialize a bass override into per-segment bars: chord-root whole/half
 * notes at octave 2 over a repeating 2-bar window (port of bassPatterns/
 * OverrideGeneratorClass.createBassPattern). `reset`/replace — the segment's
 * base bass line is discarded.
 */
export function synthesizeBassOverrideForSegment(
  segment: Segment,
  type: BassOverrideType,
): FamilyPattern {
  const notes = bassOverrideNotes(type);
  const lengthInBars = segment.bars.length;
  const bars: BarPattern[] = segment.bars.map(() => emptyBarPattern());
  // Octave 2 = MIDI 36 (matches the bass generator's `(octave+1)*12` convention).
  const rootBaseMidi = (OVERRIDE_BASS_OCTAVE + 1) * 12;

  for (let i = 0; i < lengthInBars / 2; i++) {
    for (const [hit, hitLength] of notes) {
      const bar = i * 2 + Math.floor(hit / 4);
      if (bar >= lengthInBars) continue; // legacy swallows out-of-range via try/catch
      const beat = hit % 4;
      const chordsThisBar = segment.bars[bar]!.chords;
      const chordSymbol = chordsThisBar[beat] ?? chordsThisBar[0];
      if (!chordSymbol) continue;
      // Legacy writes 'C2' on its default all-C template (the override gets no
      // chords: BassPatternGeneratorClass.js:77-84, OverrideGeneratorClass.js:64)
      // and the engine moves a plain note from C to the chord root the nearest
      // way (Tonal.h getSimpleNote, Note::deltaTo compareRoots: -5..+6).
      const root = parseChord(chordSymbol).root;
      let pitch = rootBaseMidi + nearestRootDelta(root);
      while (pitch < 0) pitch += 12;
      while (pitch > 127) pitch -= 12;
      addNoteEvent(bars[bar]!, beat, {
        type: 'note',
        note: MidiNoteSchema.parse(pitch),
        duration: hitLength,
      });
    }
  }

  return { bars };
}

function applyDrumDecision(
  ctx: GeneratorContext,
  segment: Segment,
  base: FamilyPattern,
  decision: DrumOverrideDecision,
): FamilyPattern {
  // A genre recipe's own drum styles for this section type (Casperaki Pop's hip-hop verses) are its groove: the legacy
  // section variety (masks, four-on-the-floor, re-rolls) leaves it alone (owner 2026-11-28: "not sure it always gets
  // that hip hop rhythm in the verse").
  if (drumStylesFor(ctx, segment.name)) return base;
  return applyLegacyDrumDecision(ctx, segment, base, decision);
}

function applyLegacyDrumDecision(
  ctx: GeneratorContext,
  segment: Segment,
  base: FamilyPattern,
  decision: DrumOverrideDecision,
): FamilyPattern {
  switch (decision.kind) {
    case 'none':
      return base;
    case 'mask':
      return { bars: applyDrumOverrideMask(base.bars, decision.maskType) };
    case 'floor':
      return {
        bars: synthesizeFloorPattern(
          base.bars.length,
          decision.kicksPerBar,
          decision.withClap,
          'whole',
        ),
      };
    case 'secondary': {
      // Regenerate a fresh full pattern via a segment-salted fork (the legacy
      // `secondaryPattern` re-roll; the rebuild bank has no busyness dimension).
      const laneCtx: GeneratorContext = {
        ...ctx,
        rng: ctx.rng.fork(`overrides/secondary/${segment.name}`),
      };
      const regen = generateDrumPattern(laneCtx, segment, ['drums']);
      return regen ?? base;
    }
    case 'dropOut':
      // Silence the segment's drums (empty bars through the reset path).
      return { bars: segment.bars.map(() => emptyBarPattern()) };
  }
}

/**
 * Apply the drum + bass per-segment override system to a freshly-generated
 * `PatternResult`, returning a new one with the Drums / Bass lanes rewritten.
 * Runs the full decision state machine for EVERY structure segment (so the
 * scratchpad / pool / rng stay faithful regardless of which lanes are active),
 * but only rewrites a lane that the segment actually plays.
 *
 * Determinism: forks `arrangement-polish/{drum,bass}-overrides` off the root
 * rng (fork never advances the parent), so no sibling generator's stream
 * shifts — only the Drums / Bass override bars change.
 */
export function applyArrangementOverrides(
  ctx: GeneratorContext,
  structure: SongStructure,
  selection: SelectionResult,
  patterns: PatternResult,
  /** docs/62 B13 — optionally reuse decisions computed once by the orchestrator
   *  (so transitions can read the same per-segment Drums override). The fork is
   *  name-keyed and order-independent, so passing them in is identical to the
   *  internal fork below — it just avoids running the state machine twice. */
  precomputedDrumDecisions?: Record<string, DrumOverrideDecision>,
): PatternResult {
  const drumLane = laneForFamily(selection, 'drums');
  const bassLane = laneForFamily(selection, 'bass');

  const drumDecisions =
    precomputedDrumDecisions ??
    decideDrumOverrides(
      ctx.rng.fork('arrangement-polish/drum-overrides'),
      structure,
      ctx.params.genre,
    );
  const bassDecisions = decideBassOverrides(
    ctx.rng.fork('arrangement-polish/bass-overrides'),
    structure,
  );

  const segmentByName = new Map(structure.map((s) => [s.name, s]));
  // Pattern lab: a preview of drums or bass must play the proposed pattern in every section, so
  // that lane keeps it (the decisions above still run: the rng streams stay the same).
  const keepDrums = drumPreviewFromParams(ctx.params.params) !== undefined;
  const keepBass = bassPreviewFromParams(ctx.params.params) !== undefined;

  const segments = patterns.segments.map((segPat) => {
    const segment = segmentByName.get(segPat.segmentName);
    if (!segment) return segPat;
    const lanes: Record<string, FamilyPattern> = { ...segPat.lanes };

    if (drumLane && lanes[drumLane] && !keepDrums) {
      const dec = drumDecisions[segPat.segmentName] ?? { kind: 'none' };
      lanes[drumLane] = applyDrumDecision(ctx, segment, lanes[drumLane]!, dec);
    }

    if (bassLane && lanes[bassLane] && !keepBass) {
      const bdec = bassDecisions[segPat.segmentName];
      if (bdec) lanes[bassLane] = synthesizeBassOverrideForSegment(segment, bdec);
    }

    return { segmentName: segPat.segmentName, lanes };
  });

  return { segments };
}
