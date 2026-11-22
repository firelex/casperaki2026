// docs/54p — Production wiring for `TransitionSample` lanes.
//
// Brain 53aa emits `arrangement[seg].transitions.<tag> = { type, placement }`.
// The legacy engine consumes a fully-resolved per-segment shape under
// `arrangement[seg].transitions.<inst-display-name> = { id,
// sequenceStartPosition, sequenceStartPositionOffsetInSeconds, duration,
// urls }`. This module bridges the two:
//
// 1. `resolveTransitionRow` picks a deterministic catalog row per brain
//    tag with the brightPop-first / edm-fallback policy from docs/54n §2.
// 2. `computeTransitionTiming` ports the minimum legacy
//    `TransitionsClass._getTransition` math needed for cymbalsCrashHit-
//    style attack transitions, fxDownlifter-style attack transitions,
//    and percussionBreaks*-style end-aligned transitions.
//
// The 54o `cymbalsCrashHit` fixture (proven render) is the contract.

import type { ValidatedCatalog, ValidatedCatalogEntry } from '@casperaki/arrangement';
import { pickTransitionSound } from '@casperaki/arrangement';

// ---- Tag → catalog (family, lowLevel) -----------------------------------
// Every brain transition tag we currently honour maps to one (family,
// lowLevel) pair in the validated catalog. Tags not on this list are
// dropped at the adapter layer with an `adapter` diagnostic.
export const TRANSITION_TAG_TO_LOW_LEVEL: Readonly<Record<string, {
  family: string;
  lowLevel: string;
  /** legacy `_getTransition` branch this tag belongs to. */
  timingBranch: 'attack' | 'tail';
  /** human-friendly shortName for the emitted inst-N.json. */
  shortName: string;
  /** The clip's lowLevelType for the mixer (fx group / sends) when it is not
   *  the tag itself (preview-only `fxNoiseRiseSample` → `fxNoiseRise`). */
  clipLowLevel?: string;
  /** Tonal transition: the sample carries a pitch and must be selected by
   *  key, not pitch-shifted. Legacy `TransitionsClass` (casperaki1
   *  TransitionsClass.js:334-352) picked the `fxTonalReverse` row whose
   *  `sampleDetails.note` equalled `getFinalChordForSegment(song, seg)`.
   *  The catalog ships one recording per chromatic key (`entry.key`), so
   *  resolution must filter by the segment's final-chord root. */
  tonal?: boolean;
}>> = {
  // attack — fires at segment start, climax defaults to 0.
  cymbalsCrashHit:           { family: 'cymbals', lowLevel: 'cymbalsCrashHit',  timingBranch: 'attack', shortName: 'crash' },
  fxDownlifter:              { family: 'fx',      lowLevel: 'fxDownlifter',     timingBranch: 'attack', shortName: 'downlifter' },
  fxHighImpact:              { family: 'fx',      lowLevel: 'fxHighImpact',     timingBranch: 'attack', shortName: 'highImpact' },
  fxLowImpact:               { family: 'fx',      lowLevel: 'fxLowImpact',      timingBranch: 'attack', shortName: 'lowImpact' },
  fxTransition:              { family: 'fx',      lowLevel: 'fxTransition',     timingBranch: 'attack', shortName: 'fxTransition' },
  // docs/58e — `fxOther` was the xlsx lowLevel for 15 retro-arcade
  // samples (DonkeyKong/Frogger/MsPacMan/PacMan/nintendo) before
  // build-snapshot.ts split them into `fx8bitArcade`. The brain's
  // transition tag stays `fxOther` (back-compat); resolution now
  // points at the renamed lowLevel.
  fxOther:                   { family: 'fx',      lowLevel: 'fx8bitArcade',     timingBranch: 'attack', shortName: 'fxOther' },
  // tail — ends at segment boundary, climax defaults to full sample duration.
  fxReverse:                 { family: 'fx',      lowLevel: 'fxReverse',        timingBranch: 'tail', shortName: 'reverse' },
  fxTonalReverse:            { family: 'fx',      lowLevel: 'fxTonalReverse',   timingBranch: 'tail', shortName: 'tonalReverse', tonal: true },
  fxUplifter:                { family: 'fx',      lowLevel: 'fxUplifter',       timingBranch: 'tail', shortName: 'uplifter' },
  percussionBreaksBuildups:  { family: 'percussionBreaks', lowLevel: 'percussionBreaksBuildups', timingBranch: 'tail', shortName: 'breaksBuildup' },
  percussionBreaksFills:     { family: 'percussionBreaks', lowLevel: 'percussionBreaksFills',    timingBranch: 'tail', shortName: 'breaksFill' },
  // Preview-only one-shots (brain Sounds page; see @casperaki/arrangement
  // transitions/sound.ts PREVIEW_ONLY_TRANSITION_TAGS). Fire at the section start.
  fxAtmosphere:              { family: 'fx', lowLevel: 'fxAtmosphere', timingBranch: 'attack', shortName: 'atmosphere' },
  fxFretNoise:               { family: 'fx', lowLevel: 'fxFretNoise',  timingBranch: 'attack', shortName: 'fretNoise' },
  fxNoiseRiseSample:         { family: 'fx', lowLevel: 'fxNoiseRise',  timingBranch: 'tail',   shortName: 'noiseRise', clipLowLevel: 'fxNoiseRise' },
  percussionMiscAcousticHigh:   { family: 'percussionMisc', lowLevel: 'percussionMiscAcousticHigh',   timingBranch: 'attack', shortName: 'perc' },
  percussionMiscAcousticLow:    { family: 'percussionMisc', lowLevel: 'percussionMiscAcousticLow',    timingBranch: 'attack', shortName: 'perc' },
  percussionMiscElectronicHigh: { family: 'percussionMisc', lowLevel: 'percussionMiscElectronicHigh', timingBranch: 'attack', shortName: 'perc' },
  percussionMiscElectronicLow:  { family: 'percussionMisc', lowLevel: 'percussionMiscElectronicLow',  timingBranch: 'attack', shortName: 'perc' },
};

// ---- Catalog row resolution ---------------------------------------------

export interface ResolveTransitionInput {
  catalog: ValidatedCatalog;
  tag: string;
  segmentName: string;
  genre: string;
  /** stable seed for deterministic pick (e.g. brain hash). */
  seed: string;
  /** Final-chord root of the segment (e.g. `A`, `C#`, `Bb`), as produced by
   *  {@link finalChordRootForSegment}. Required to key-match a `tonal`
   *  transition; ignored for non-tonal tags. */
  finalChordRoot?: string | null;
  /** Song tempo in BPM. Required to bpm-match the percussionBreaks* lanes,
   *  which ship one pre-rendered row per integer bpm (legacy never
   *  time-stretched them — it selected the variant whose `sampleDetails.bpm`
   *  equalled the song tempo; casperaki2 TransitionsClass.js:457). Ignored
   *  for every other tag. */
  tempo?: number;
}

/** Root of a section's final chord — shared with the generator (see
 *  @casperaki/arrangement transitions/sound.ts). */
export { finalChordRootForSegment } from '@casperaki/arrangement';

export interface ResolvedTransitionRow {
  entry: ValidatedCatalogEntry;
  /** 'genre' if the pick came from the genre-tagged subset; 'fallback' if we had to fall back; 'chosen' for a stored soundId. */
  source: 'genre' | 'fallback' | 'chosen';
}

/** Deterministic catalog pick. brightPop subset first; if empty (true for
 *  every `fx*` row in today's audit — see docs/54n §2), fall back to the
 *  full validated subset for the tag's (family, lowLevel) and pick again. */
export function resolveTransitionRow(input: ResolveTransitionInput): ResolvedTransitionRow | null {
  // The pick lives in @casperaki/arrangement (transitions/sound.ts), shared
  // with the generator — which now stores it in the entry (`soundId`). This
  // seeded path only serves entries saved without one.
  if (!TRANSITION_TAG_TO_LOW_LEVEL[input.tag]) return null;
  return pickTransitionSound(
    input.catalog,
    input.tag,
    { genre: input.genre, tempo: input.tempo ?? NaN, finalChordRoot: input.finalChordRoot ?? null },
    input.seed,
    input.segmentName,
  );
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// ---- Timing ports from legacy TransitionsClass._getTransition -----------

export interface ComputeTransitionTimingInput {
  tag: string;
  /** seconds — segment.bars * 4 * 60/tempo. */
  segmentDurationSeconds: number;
  /** seconds — ffprobe of the staged playsample. */
  sampleDurationSeconds: number;
  /** seconds — db-stored climax. Legacy defaulted to `sampleDurationSeconds`
   *  for tail transitions and `0` for attack transitions. Pass `null` to
   *  use those defaults. */
  sampleClimaxSeconds: number | null;
  /** song tempo in BPM. */
  tempo: number;
  /** brain placement hint — only honoured for `tail` transitions when the
   *  computed offset would land outside the segment. */
  placement: 'beginningOfSegment' | 'midSegment' | 'endOfSegment' | undefined;
}

export interface TransitionTiming {
  /** integer 32nd-note position from segment start. */
  sequenceStartPosition: number;
  /** sub-32nd offset in seconds (0 for percussionBreaks* — bar-aligned). */
  sequenceStartPositionOffsetInSeconds: number;
  /** clip duration in seconds (= sample duration, capped at segment end). */
  duration: number;
}

export function computeTransitionTiming(input: ComputeTransitionTimingInput): TransitionTiming {
  const map = TRANSITION_TAG_TO_LOW_LEVEL[input.tag];
  if (!map) {
    return { sequenceStartPosition: 0, sequenceStartPositionOffsetInSeconds: 0, duration: input.sampleDurationSeconds };
  }
  const tempo = input.tempo;
  const sampleDur = input.sampleDurationSeconds;
  const segDur = input.segmentDurationSeconds;

  if (map.timingBranch === 'attack') {
    // Legacy: climax = sampleDetails.climax || 0; startPositionIn32ndNotes = (-climax) * tempo / 60 * 8.
    // With climax=0 (our default for attack types): startPos = 0, offset = 0.
    const climax = input.sampleClimaxSeconds ?? 0;
    const startIn32 = (-climax) * tempo / 60 * 8;
    const startInt = Math.floor(startIn32) || 0; // normalize -0 → 0
    const offsetSec = (((startIn32 - startInt) / 8) * 60 / tempo) || 0;
    return {
      sequenceStartPosition: startInt,
      sequenceStartPositionOffsetInSeconds: offsetSec,
      duration: sampleDur,
    };
  }

  // tail branch
  // Legacy: climax = sampleDetails.climax || sampleDetails.duration; startPositionIn32ndNotes = (segDur - climax) * tempo/60 * 8.
  // percussionBreaks*: bar-aligned (floor or ceil divisible by 32). Others: rounded down with sub-32nd offset.
  const climax = input.sampleClimaxSeconds ?? sampleDur;
  const startIn32 = (segDur - climax) * tempo / 60 * 8;
  const startInt = Math.floor(startIn32);

  if (input.tag === 'percussionBreaksBuildups') {
    const aligned = Math.floor(startInt / 32) * 32;
    return { sequenceStartPosition: aligned, sequenceStartPositionOffsetInSeconds: 0, duration: sampleDur };
  }
  if (input.tag === 'percussionBreaksFills') {
    const aligned = Math.ceil(startInt / 32) * 32;
    return { sequenceStartPosition: aligned, sequenceStartPositionOffsetInSeconds: 0, duration: sampleDur };
  }
  // fxReverse / fxTonalReverse / fxUplifter
  const offsetSec = ((startIn32 - startInt) / 8) * 60 / tempo;
  return {
    sequenceStartPosition: startInt,
    sequenceStartPositionOffsetInSeconds: offsetSec,
    duration: sampleDur,
  };
}

// ---- inst-N.json + transition block builders ----------------------------

export interface BuiltTransitionInst {
  filename: string;
  json: {
    id: number;
    name: string;
    shortName: string;
    type: 'transitionSample';
    lowLevelType: string;
    isSample: true;
    isVst: false;
    details: { bpm: number; duration: number; climax: number };
    /** echoed from catalog for traceability; engine ignores it. */
    sourcePath?: string;
    catalogId?: string;
  };
}

/** Per-inst payload + the matching arrangement[seg].transitions.<name>
 *  block. The engine reads `transitionData` from the per-segment block
 *  via `getTransitionSegmentData`, keyed by the inst's `name` field. */
export interface BuiltTransition {
  inst: BuiltTransitionInst;
  segmentName: string;
  /** key under arrangement[seg].transitions — equals inst.name. */
  blockKey: string;
  block: {
    id: number;
    sequenceStartPosition: number;
    sequenceStartPositionOffsetInSeconds: number;
    duration: number;
    urls: string[];
  };
}

export interface BuildTransitionInput {
  tag: string;
  segmentName: string;
  /** sequential id assigned by the caller. Per-segment-per-tag is fine —
   *  the legacy engine routes by inst.name (= the engine display name). */
  playsampleId: number;
  /** for filename (inst-N.json) ordering. */
  filenameIndex: number;
  resolvedRow: ResolvedTransitionRow;
  timing: TransitionTiming;
  /** for inst.details.duration; ffprobe value. */
  sampleDurationSeconds: number;
  /** for inst.details.climax — 0 for attack transitions, equal to sample
   *  duration for tail transitions. */
  sampleClimaxSeconds: number;
}

/** Build the inst-N.json AND the engine arrangement-block in one shot,
 *  keyed so the engine routes the block to this inst via `name`. */
export function buildTransitionAssets(input: BuildTransitionInput): BuiltTransition {
  const map = TRANSITION_TAG_TO_LOW_LEVEL[input.tag];
  // Engine routes per-segment transition data via
  // `arrangement[seg].transitions[inst.name]` — same lookup is run for
  // every inst on every segment. If two TransitionSample insts share a
  // name (e.g. four `fxTonalReverse` insts, one per anchor segment),
  // every inst fires on every segment that has any `fxTonalReverse`
  // block, with the wrong sample paired to the right timing. So the
  // name MUST be globally unique. Use `<tag>__<segment>` — the
  // arrangement block uses the same key.
  const name = `${input.tag}__${input.segmentName}`;

  return {
    inst: {
      filename: `inst-${input.filenameIndex}.json`,
      json: {
        id: input.playsampleId,
        name,
        shortName: map?.shortName ?? input.tag,
        type: 'transitionSample',
        lowLevelType: map?.clipLowLevel ?? input.tag,
        isSample: true,
        isVst: false,
        details: {
          bpm: 0,
          duration: input.sampleDurationSeconds,
          climax: input.sampleClimaxSeconds,
        },
        sourcePath: input.resolvedRow.entry.matchedPath,
        catalogId: input.resolvedRow.entry.id,
      },
    },
    segmentName: input.segmentName,
    blockKey: name,
    block: {
      id: input.playsampleId,
      sequenceStartPosition: input.timing.sequenceStartPosition,
      sequenceStartPositionOffsetInSeconds: input.timing.sequenceStartPositionOffsetInSeconds,
      duration: input.timing.duration,
      urls: [`/playSample/${input.playsampleId}`],
    },
  };
}

/** Convenience: per-tag default climax (0 for attack, sampleDur for tail). */
export function defaultClimaxForTag(tag: string, sampleDurationSeconds: number): number {
  const map = TRANSITION_TAG_TO_LOW_LEVEL[tag];
  if (!map) return 0;
  return map.timingBranch === 'attack' ? 0 : sampleDurationSeconds;
}

// ---- edmSnareDrumRoll (TransitionPattern) -------------------------------
//
// Unlike every other transition tag, `edmSnareDrumRoll` is NOT a one-shot
// sample — it's a step pattern played through a two-sample sampler (engine
// `TransitionPattern.h`). The brain attaches the snare-roll grid to the
// transition entry (`arrangement-polish/edm-snare-roll.ts`); here we pick two
// electronic snares and lower the engine inst + clip block.
//
// Legacy selection (casperaki2 TransitionsClass.js:336): the `snareDrumsElectronic`
// rows tagged `edm`, two picked independently (may repeat). The brain catalog
// represents the legacy `edm` tag as `mainStyle`/`addStyles`.

export const EDM_SNARE_DRUM_ROLL_TAG = 'edmSnareDrumRoll';
const SNARE_ROLL_LOWLEVEL = 'snareDrumsElectronic';
const SNARE_ROLL_STYLE = 'edm';
// Engine maps pattern channel 0 → samples[0], channel 1 → samples[1]; the note
// names just need to be distinct (legacy InstrumentalGenerator.h:645/653).
const SNARE_ROLL_SAMPLE_NOTES = ['C1', 'G1'] as const;

export interface ResolvedSnareRollSamples {
  /** Exactly two catalog rows (legacy `twoSamples`); may be the same row. */
  rows: [ValidatedCatalogEntry, ValidatedCatalogEntry];
  /** 'genre' when picked from the edm-tagged subset, 'fallback' otherwise. */
  source: 'genre' | 'fallback';
}

/** Pick the two electronic snares for a snare-roll. Deterministic on
 *  `(seed, segmentName)`. Returns null when the catalog has no electronic
 *  snare at all (legacy `continue` — the transition is dropped). */
export function resolveSnareRollSamples(input: {
  catalog: ValidatedCatalog;
  segmentName: string;
  seed: string;
}): ResolvedSnareRollSamples | null {
  const all = input.catalog.entries.filter((e) => e.lowLevel === SNARE_ROLL_LOWLEVEL);
  if (all.length === 0) return null;
  const edm = all.filter(
    (e) => e.mainStyle === SNARE_ROLL_STYLE || ((e.addStyles ?? []) as readonly string[]).includes(SNARE_ROLL_STYLE),
  );
  const pool = edm.length > 0 ? edm : all;
  const sorted = pool.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // Two independent deterministic picks (legacy used `selectRandomly` twice).
  const i0 = fnv1a(`${input.seed}:${input.segmentName}:${EDM_SNARE_DRUM_ROLL_TAG}:0`) % sorted.length;
  const i1 = fnv1a(`${input.seed}:${input.segmentName}:${EDM_SNARE_DRUM_ROLL_TAG}:1`) % sorted.length;
  return { rows: [sorted[i0]!, sorted[i1]!], source: edm.length > 0 ? 'genre' : 'fallback' };
}

/** Snare-roll clip start in 32nd notes. The roll is right-aligned at the
 *  segment end: `segmentEnd_32 - lengthInBars*32`, where
 *  `segmentEnd_32 = floor(segDurSeconds * tempo/60 * 8)` (docs/54n:262 /
 *  legacy RendererClass). Offset is always 0 — the grid is bar-aligned. */
export function computeSnareRollTiming(input: {
  segmentDurationSeconds: number;
  tempo: number;
  lengthInBars: number;
}): { sequenceStartPosition: number; sequenceStartPositionOffsetInSeconds: number } {
  const segEnd32 = Math.floor(input.segmentDurationSeconds * input.tempo / 60 * 8);
  return {
    sequenceStartPosition: segEnd32 - input.lengthInBars * 32,
    sequenceStartPositionOffsetInSeconds: 0,
  };
}

export interface BuiltSnareRollInst {
  filename: string;
  json: {
    id: number;
    name: string;
    shortName: string;
    type: 'transitionPattern';
    lowLevelType: string;
    sampleOrVst: 'twoSamples';
    isSample: true;
    isVst: false;
    /** Engine `TransitionPattern.h` reads `samples[i].{note,id}`; channel `i`
     *  of the step grid plays `samples[i]`. `sourcePath`/`catalogId` are for
     *  the prestage staging script (engine ignores them). */
    samples: Array<{ note: string; id: number; sourcePath?: string; catalogId?: string }>;
  };
}

export interface BuiltSnareRoll {
  inst: BuiltSnareRollInst;
  segmentName: string;
  blockKey: string;
  block: {
    id: number;
    sequenceStartPosition: number;
    sequenceStartPositionOffsetInSeconds: number;
    /** Engine reads `config.details.pattern` (channel→grid) + `lengthInBars`. */
    config: { details: { pattern: Readonly<Record<string, string>>; lengthInBars: number } };
  };
}

export interface BuildSnareRollInput {
  segmentName: string;
  /** Inst id; also the block id the engine matches against
   *  (`getTransitionSegmentData`: block.id === inst.id). */
  instId: number;
  /** Two playsample ids for the snare audio (engine downloads playsample-<id>). */
  sampleIds: [number, number];
  filenameIndex: number;
  samples: ResolvedSnareRollSamples;
  /** The brain-generated grid (`arrangement[seg].transitions.edmSnareDrumRoll.pattern`). */
  pattern: Readonly<Record<string, string>>;
  lengthInBars: number;
  timing: { sequenceStartPosition: number; sequenceStartPositionOffsetInSeconds: number };
}

/** Build the transitionPattern inst-N.json + arrangement block. */
export function buildSnareRollPatternAssets(input: BuildSnareRollInput): BuiltSnareRoll {
  const name = `${EDM_SNARE_DRUM_ROLL_TAG}__${input.segmentName}`;
  return {
    inst: {
      filename: `inst-${input.filenameIndex}.json`,
      json: {
        id: input.instId,
        name,
        shortName: 'edmSnareRoll',
        type: 'transitionPattern',
        lowLevelType: SNARE_ROLL_LOWLEVEL,
        sampleOrVst: 'twoSamples',
        isSample: true,
        isVst: false,
        samples: input.samples.rows.map((row, i) => ({
          note: SNARE_ROLL_SAMPLE_NOTES[i] ?? `C${i + 1}`,
          id: input.sampleIds[i] ?? input.sampleIds[0],
          sourcePath: row.matchedPath,
          catalogId: row.id,
        })),
      },
    },
    segmentName: input.segmentName,
    blockKey: name,
    block: {
      id: input.instId,
      sequenceStartPosition: input.timing.sequenceStartPosition,
      sequenceStartPositionOffsetInSeconds: input.timing.sequenceStartPositionOffsetInSeconds,
      config: { details: { pattern: input.pattern, lengthInBars: input.lengthInBars } },
    },
  };
}

// ---- fxNoiseRise (transitionNoise) — docs/62 A7 ------------------------------
//
// Port of casperaki2 EffectsClass.getEffect('fxNoiseRise') + _getStartPoint
// (EffectsClass.js:11-44, 93-112). The brain emits `transitions.fxNoiseRise =
// {type, placement}`; this expands it into the param object the WASM engine's
// `resolveNoiseRises` reads to build a synthesized white-noise riser. The legacy
// randomly picks one of 5 start types; we pick deterministically (FNV over the
// segment name) so the render stays reproducible.

const FX_NOISE_RISE_TYPES = [
  'beginningOfSegment',
  'middleOfSegment',
  'oneBarBeforeEndOfSegment',
  'twoBarsBeforeEndOfSegment',
  'threeBarsBeforeEndOfSegment',
] as const;

/** EffectsClass._getStartPoint — start position in 32nd notes for a given type
 *  (32 32nds per bar). */
function noiseRiseStartPos32(type: string, bars: number): number {
  switch (type) {
    case 'middleOfSegment':
      return (bars / 2) * 32;
    case 'oneBarBeforeEndOfSegment':
      return (bars - 1) * 32;
    case 'twoBarsBeforeEndOfSegment':
      return (bars - 2) * 32;
    case 'threeBarsBeforeEndOfSegment':
      return (bars - 3) * 32;
    case 'beginningOfSegment':
    default:
      return 0;
  }
}

export interface NoiseRiseParams {
  type: 'fxNoiseRise';
  placement: string;
  fxNoiseRiseType: string;
  /** start position in 32nd notes (8 per beat). */
  sequenceStartPosition: number;
  sequenceStartPositionOffsetInSeconds: number;
  /** seconds */
  attackDuration: number;
  decaySequenceStartPositionOffsetInSeconds: number;
  decayDuration: number;
  frequencyStart: number;
  frequencyEnd: number;
  /** dB */
  volumeAttack: number;
  volumeSustain: number;
  volumeDecay: number;
}

export interface BuildNoiseRiseInput {
  segmentName: string;
  segmentBars: number;
  tempo: number;
  placement: string;
}

export function buildNoiseRiseBlock(input: BuildNoiseRiseInput): NoiseRiseParams {
  const { segmentName, segmentBars, tempo } = input;
  const fxNoiseRiseType =
    FX_NOISE_RISE_TYPES[fnv1a(`fxNoiseRise:${segmentName}`) % FX_NOISE_RISE_TYPES.length]!;
  // Clamp into [0, (bars-1)*32]: keep the start inside the segment and guarantee
  // at least one bar of attack (short segments would otherwise yield a negative
  // start position from the *BeforeEndOfSegment types).
  const rawStart = noiseRiseStartPos32(fxNoiseRiseType, segmentBars);
  const sequenceStartPosition = Math.max(0, Math.min(rawStart, Math.max(0, segmentBars - 1) * 32));
  // EffectsClass.js:99-103 — attack spans from the start position to the segment
  // end; decay is a fixed 3 bars (extends into the following chorus).
  const attackDuration = ((segmentBars - sequenceStartPosition / 32) * 4 * 60) / tempo;
  const decayDuration = (3 * 4 * 60) / tempo;
  return {
    type: 'fxNoiseRise',
    placement: input.placement,
    fxNoiseRiseType,
    sequenceStartPosition,
    sequenceStartPositionOffsetInSeconds: 0,
    attackDuration,
    decaySequenceStartPositionOffsetInSeconds: attackDuration,
    decayDuration,
    frequencyStart: 100,
    frequencyEnd: 20000,
    volumeAttack: -30,
    volumeSustain: -20,
    volumeDecay: -50,
  };
}
