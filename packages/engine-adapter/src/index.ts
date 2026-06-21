// @casperaki/engine-adapter
//
// Owns the canonical Song → legacy engine-envelope lowering.
//
// The adapter walks the brain's full `songStructure` and emits a
// corresponding multi-segment legacy engine envelope. Lanes lowered today:
//   * Drums / Bass / Keys / Pad overrides       (53t / 53w / 53y / 53z)
//   * Drums fills — pass-through from brain 53aa (54o)
//   * TransitionSample blocks (cymbalsCrashHit, fxDownlifter, fxHighImpact,
//     fxLowImpact, fxTransition, fxOther, fxReverse, fxTonalReverse,
//     fxUplifter, percussionBreaksBuildups, percussionBreaksFills) — wired
//     IFF the caller supplies `transitionCatalog` + `getTransitionSample
//     DurationSeconds`. Otherwise transitions are emitted as empty `{}`
//     (back-compat for callers without a sample library mounted). (54p)
//   * Percussion loops — one inst-N.json per brain-emitted Loop
//     `InstrumentDefinition` + per-segment `instruments[<loopName>]`
//     activation flags. Wired IFF the caller supplies `loopSampleProbe`.
//     (54r)
//   * Guitar (acoustic + electric, same engine class) — per-note
//     multisample inst + 8-slot fret-noise pool + virtualGuitarist
//     chord-strum pool. Lowered by `guitars.ts` when the brain selects
//     a Guitar role. (54s / 54t / 54u / 54v)
//   * Signal processors (LP cutoff sweeps) — brain tag → per-32nd-note
//     automation point array via `signal-processors.ts`. Render-path
//     wired; engine-side AutomatableParameter read still under
//     investigation (Yellow, partial). (54q)
//
// Still deferred:
//   * Vocals — brain emits a Vocal arrangement entry today but vocal
//     track rendering is deferred (see docs/53z + 53f + the SoulX vs.
//     Vocaloid decision gate in 50-engineering-plan §"Phase 4").
//   * Mutes — brain stub returns nothing (53aa item #1 / dead-code in
//     legacy drums.js). No engine consumer until brain emits real mutes.
//   * TransitionNoise (fxNoiseRise) — brain doesn't emit for brightPop;
//     engine class exists but needs harness plugin-cleanup whitelist +
//     EffectsClass param port (54n §2 / 54p §"Known follow-ups").
//   * TransitionPattern (edmSnareDrumRoll) — zero validated catalog
//     rows; blocked on DB-import (54n §2).
//   * Guitar per-string strums (`type: 'strum'`) — needs
//     `GuitarChord::getLowestPosition()` positional MIDI port. The
//     virtualGuitarist chord-strum lane (54v) is Green; the
//     per-string lane stays Yellow.
//
// Pointer docs:
//
//   docs/53t-step9-engine-adapter-package.md      (initial Drums adapter)
//   docs/53w-step12-bass-adapter-render.md         (Bass family added)
//   docs/53y-step14-keys-pad-adapter-render.md     (Keys + Pad added)
//   docs/53z-step15-multi-segment-render.md        (multi-segment walk)
//   docs/53k-legacy-import-inventory.md            (engine-bridge inventory)
//   docs/54o-loop-transition-fills-render.md       (fills pass-through +
//                                                   spike proofs)
//   docs/54p-transition-adapter-wiring.md          (TransitionSample lower)
//   docs/54q-signal-processor-port.md              (signal processors)
//   docs/54r-loop-adapter-wiring.md                (percussion loops)
//   docs/54s-guitar-adapter-wiring.md              (Guitar chord comp)
//   docs/54t-guitar-fret-noise-wiring.md           (Guitar fret noises)
//   docs/54u-electric-guitar-wiring.md             (multi-family Guitar)
//   docs/54v-guitar-strum-wiring.md                (virtualGuitarist strums)
//   docs/54w-engine-bridge-consolidation.md        (whole-bridge overview)
//
// The module is pure: no native engine calls, no file writes, no live
// asset-resolver calls. The CLI driver in apps/engine-spike is the only
// thing that touches the filesystem. The optional per-family
// `<family>AssetResolution` options let the CLI surface the resolver's
// verdict in diagnostics without coupling this package to
// `@casperaki/arrangement`.

import { readFileSync } from 'node:fs';

import type { ValidatedCatalog, ValidatedCatalogEntry } from '@casperaki/arrangement';
import type {
  AdapterDiagnostic,
  InstrumentDefinition,
  Song,
} from '@casperaki/song-schema';
import {
  EDM_SNARE_DRUM_ROLL_TAG,
  TRANSITION_TAG_TO_LOW_LEVEL,
  buildNoiseRiseBlock,
  buildSnareRollPatternAssets,
  buildTransitionAssets,
  computeSnareRollTiming,
  computeTransitionTiming,
  defaultClimaxForTag,
  finalChordRootForSegment,
  resolveSnareRollSamples,
  resolveTransitionRow,
} from './transitions.js';
import {
  computeSignalProcessor,
  isSupportedSignalProcessorTag,
} from './signal-processors.js';
import {
  buildLoopInst,
  loopDefinitions,
  segmentHasLoopActive,
  type LoopSampleProbe,
} from './loops.js';
import { collectUnrecognizedLowLevelTypes } from './instrument-volume-types.js';
import {
  DEFAULT_GUITAR_FRET_NOISE_COUNT,
  DEFAULT_GUITAR_FRET_NOISE_ID_BASE,
  DEFAULT_GUITAR_SAMPLE_ID_BASE,
  DEFAULT_GUITAR_STRUM_ID_BASE,
  DEFAULT_GUITAR_VST_ID,
  buildGuitarInst,
  collectStrumPoolEntries,
} from './guitars.js';
import {
  DEFAULT_PLUCKED_SYNTHS_SAMPLE_ID_BASE,
  DEFAULT_PLUCKED_SYNTHS_VST_ID,
  DEFAULT_POP_BRASS_SAMPLE_ID_BASE,
  DEFAULT_POP_BRASS_VST_ID,
  DEFAULT_POP_STRINGS_SAMPLE_ID_BASE,
  DEFAULT_POP_STRINGS_VST_ID,
  DEFAULT_SYNTHS_SAMPLE_ID_BASE,
  DEFAULT_SYNTHS_VST_ID,
  buildPluckedSynthsInst,
  buildPopBrassInst,
  buildPopStringsInst,
  buildSynthsInst,
} from './synths.js';

export interface BrainProvenance {
  hash: string;
  params: Readonly<Record<string, unknown>>;
  generator?: string;
}

/**
 * Optional pre-resolved tonal asset (Bass / Keys / Pad), recorded in
 * adapter diagnostics. Lets the CLI pass the result of
 * `resolveAssetPath(entry, { key, bpm })` through to the engine fixture
 * without coupling this package to the resolver implementation. Shape
 * mirrors `AssetResolution` from `@casperaki/arrangement` so the CLI
 * can pass the value verbatim.
 */
export interface AssetResolutionInfo {
  status: 'resolved' | 'unresolved';
  /** sample-library-relative path when `status === 'resolved'`. */
  relativePath?: string;
  /** Resolver match kind (`canonical` / `exact-key-bpm-variant`) when resolved. */
  matchKind?: string;
  /** Reason for the unresolved verdict, surfaced verbatim in diagnostics. */
  reason?: string;
  /** Catalog row id the resolver was asked about. */
  entryId?: string;
  /** Catalog family of the resolved row (e.g. `basses`, `keys`,
   *  `popStrings`). Mirrors the resolver output. */
  family?: string;
  /** Catalog granular lowLevel of the resolved row (e.g.
   *  `keysAcousticPiano`). Applied as the emitted instrument's
   *  `lowLevelType` so the engine mixes/routes the correct family. */
  lowLevel?: string;
}

/** @deprecated alias for {@link AssetResolutionInfo} — kept for back-compat. */
export type BassAssetResolutionInfo = AssetResolutionInfo;

export interface ToEngineFixtureOptions {
  /** sha256 of canonicalStringifySong(song) — recorded into the envelope. */
  brainHash: string;
  /** orchestrator params the brain ran with — opaque to the adapter. */
  generatorParams: Readonly<Record<string, unknown>>;
  /** generator name written into envelope.brainProvenance. */
  generatorName?: string;
  /**
   * Optional asset-resolver verdict for the brain's selected bass row.
   * Recorded in diagnostics only — the bundled `base-bass-inst.json`
   * still ships the legacy VST sample ids (945..960) so the engine's
   * batchRun() cache short-circuit (see docs/53w + 52f §B) keeps working.
   */
  bassAssetResolution?: AssetResolutionInfo;
  /** Same shape and semantics as `bassAssetResolution` (Keys family). */
  keysAssetResolution?: AssetResolutionInfo;
  /** Same shape and semantics as `bassAssetResolution` (Pad family). */
  padAssetResolution?: AssetResolutionInfo;
  /** Validated catalog used to resolve `arrangement[seg].transitions.<tag>`
   *  brain emissions (53aa) into engine-ready transitionSample inst-N.json
   *  files + per-segment transition blocks. Omitted → transitions stay
   *  empty (back-compat with pre-54p callers). docs/54p. */
  transitionCatalog?: ValidatedCatalog;
  /** Required when `transitionCatalog` is provided: synchronously return the
   *  duration (in seconds) of the resolved sample. Adapter is pure (no
   *  child_process), so the caller passes a callback that wraps `ffprobe`
   *  / file-stat / cache lookup. Returning `null` drops the transition
   *  with a diagnostic. */
  getTransitionSampleDurationSeconds?: (entry: ValidatedCatalogEntry) => number | null;
  /** Starting inst-N.json playsample id for transitionSample emissions.
   *  Defaults to 40000 — picked to sit above the Phase 2 fixture id
   *  ranges (Drums 26929-27770, Bass 945-960, Keys 2048-2064, Pad
   *  3153-3169) and the spike id range (6000s in docs/54o). */
  transitionPlaysampleIdBase?: number;
  /** Starting inst-N.json filename index for transitionSamples. Defaults
   *  to 5 (after Drums=1, Bass=2, Keys=3, Pad=4). */
  transitionInstFilenameStart?: number;
  /** Caller-supplied duration probe for the brain's percussion-loop
   *  InstrumentDefinitions. Required for Loop lowering — the engine's
   *  `Loop.h` ctor reads `details.duration` and the adapter is pure
   *  (no FS / child_process). Returning a null duration drops the loop
   *  with a diagnostic. Without this option the adapter still walks
   *  the brain's loop definitions but emits an `adapter` diagnostic
   *  and skips all Loop inst-N.json emission (back-compat with
   *  pre-54r callers). docs/54r. */
  loopSampleProbe?: LoopSampleProbe;
  /** Starting inst-N.json playsample id for Loop emissions. Defaults
   *  to 50000 — picked to sit above the transition base (40000). */
  loopPlaysampleIdBase?: number;
}

export interface InstrumentEnvelopeFile {
  /** Filename the engine driver should write this JSON to. */
  filename: string;
  json: unknown;
}

export interface EngineFixture {
  /** Legacy engine-envelope `song.json` shape. */
  songJson: unknown;
  /** One JSON file per emitted instrument. Drums always; Bass/Keys/Pad when active. */
  instruments: InstrumentEnvelopeFile[];
  /** Adapter diagnostics — multi-segment summary + per-family scope notes. */
  diagnostics: AdapterDiagnostic[];
}

const DEFAULT_GENERATOR_NAME = '@casperaki/arrangement.orchestrate';

// Phase-2 known-good engine envelope. Read at module init from the fixture
// dir shipped with this package. The envelope is the shape the native engine
// in apps/engine-spike is already proven to render non-silently; the legacy
// per-family instrument fixtures are the inst blocks the engine's
// Drums / Bass / Keys / Pad constructors require.
const BASE_ENGINE_SONG = readFileSync(
  new URL('../fixtures/base-engine-song.json', import.meta.url),
  'utf-8',
);
const BASE_DRUMS_INST = readFileSync(
  new URL('../fixtures/base-drums-inst.json', import.meta.url),
  'utf-8',
);
const BASE_BASS_INST = readFileSync(
  new URL('../fixtures/base-bass-inst.json', import.meta.url),
  'utf-8',
);
const BASE_KEYS_INST = readFileSync(
  new URL('../fixtures/base-keys-inst.json', import.meta.url),
  'utf-8',
);
const BASE_PAD_INST = readFileSync(
  new URL('../fixtures/base-pad-inst.json', import.meta.url),
  'utf-8',
);

// docs/58c — per-catalog-row octaveAdjustment lookup, produced by
// apps/engine-spike/scripts/classify-octave-adjustment-catalog.mjs
// (legacy-faithful pYIN classifier over all 286 tonal catalog rows).
// Every emitted tonal inst-N.json gets `details.octaveAdjustment` set
// from this map; rows the classifier couldn't lock onto (the 27
// kontakt orchestral multi-note phrases) carry adjustment=0 with
// adjustmentReliable=false — same default the legacy script's
// `'Unknown' → 0` fallback produced.
const OCTAVE_ADJUSTMENT_BY_CATALOG_ID: ReadonlyMap<string, number> = (() => {
  const raw = JSON.parse(
    readFileSync(
      new URL('../data/octave-adjustment-per-row.json', import.meta.url),
      'utf-8',
    ),
  ) as { byCatalogId: Record<string, { adjustment: number }> };
  const m = new Map<string, number>();
  for (const [id, e] of Object.entries(raw.byCatalogId)) m.set(id, e.adjustment);
  return m;
})();

function octaveAdjustmentFor(catalogId: string | null | undefined): number {
  if (!catalogId) return 0;
  return OCTAVE_ADJUSTMENT_BY_CATALOG_ID.get(catalogId) ?? 0;
}

// Mutate `instJson.details.octaveAdjustment` in place. Used at every
// tonal inst-N.json emit site so the engine reads the real value
// instead of `null` (which JUCE coerces to 0, skipping the transpose).
function setOctaveAdjustment(
  instJson: unknown,
  catalogId: string | null | undefined,
): void {
  if (!instJson || typeof instJson !== 'object') return;
  const obj = instJson as { details?: unknown };
  if (!obj.details || typeof obj.details !== 'object') return;
  (obj.details as { octaveAdjustment?: number | null }).octaveAdjustment =
    octaveAdjustmentFor(catalogId);
}

// Override a fixed Phase-2 wrapper's hardcoded top-level `lowLevelType`
// with the brain-selected catalog row's `lowLevel`. The Bass/Keys/Pad
// fixtures (base-{bass,keys,pad}-inst.json) hardcode a lowLevelType
// (e.g. Keys = `synthsBrightPad`, Pad = `synthsSoftPad`) that no longer
// matches the row the resolver actually picked. The engine keys its
// volume table (FX::getInstrumentTargetVolume), FX submix routing
// (FX::getFXGroupFromLowLevelType — Instrument.cpp:15) AND per-instrument
// FX chain (Sequencer.cpp:276-303) on lowLevelType, so a stale value
// mixes/routes the lane as the WRONG family — e.g. Keys rendered as a
// synth pad at -21 dB instead of a piano at 0 dB. The selected sample is
// already staged into the wrapper's slots (prestage real-slice path), so
// only this metadata needs to track the selection. Engine *subclass*
// dispatch keys on `type` (left untouched — Synths.h/Bass.h ignore the
// type enum beyond dispatch), so overriding lowLevelType is safe. No-op
// when the resolver did not resolve a row (keeps the fixture default).
function setResolvedLowLevelType(
  instJson: unknown,
  resolution: AssetResolutionInfo | undefined,
): void {
  if (!instJson || typeof instJson !== 'object') return;
  if (resolution?.status !== 'resolved') return;
  const lowLevel = resolution.lowLevel;
  if (typeof lowLevel !== 'string' || lowLevel.length === 0) return;
  (instJson as { lowLevelType?: string }).lowLevelType = lowLevel;
}

// docs/58d + 58e — transition fx climax overrides, two-layered:
//   1. byCatalogId — per-row hand-tuned values from legacy
//      effectsMetadata.json that map cleanly to today's xlsx rows.
//   2. byLowLevel — family-wide conventions Stefan applied uniformly
//      across all rows of a lowLevel (e.g. fxTonalReverse = 1.1 sec).
// Adapter lookup priority at the transition lowering call site:
//   byCatalogId → byLowLevel → defaultClimaxForTag heuristic.
const { TRANSITION_CLIMAX_BY_CATALOG_ID, TRANSITION_CLIMAX_BY_LOWLEVEL } = (() => {
  const raw = JSON.parse(
    readFileSync(
      new URL('../data/transition-climax-overrides.json', import.meta.url),
      'utf-8',
    ),
  ) as {
    byCatalogId: Record<string, { climaxSec: number }>;
    byLowLevel?: Record<string, { climaxSec: number }>;
  };
  const byId = new Map<string, number>();
  for (const [id, entry] of Object.entries(raw.byCatalogId)) byId.set(id, entry.climaxSec);
  const byLL = new Map<string, number>();
  for (const [ll, entry] of Object.entries(raw.byLowLevel ?? {})) byLL.set(ll, entry.climaxSec);
  return { TRANSITION_CLIMAX_BY_CATALOG_ID: byId, TRANSITION_CLIMAX_BY_LOWLEVEL: byLL };
})();

const DRUMS_DISPLAY_NAME = 'Drums';
const BASS_DISPLAY_NAME = 'Bass';
const KEYS_DISPLAY_NAME = 'Keys';
const PAD_DISPLAY_NAME = 'Pad';

// Vocals are intentionally not lowered (deferred) — they're excluded from
// the tonal-lane discovery by carrying instrumentGroup `Vocal`, which maps
// to no builder kind. Tonal lanes (Bass/Keys/Pad/Guitar/Synths/…) are now
// discovered generically from the lane model (see discoverTonalLanes); the
// old fixed `TONAL_FAMILIES` display-name list has been removed.

// docs/56b §"Engine patterns[] gap" + docs/54w — engine-envelope rule.
//
// Engine `Instrument::Type` strings (Instrument.cpp:111-140 typeTable)
// that route to a TonalInstrument-derived class (Bass.h / Synths.h /
// Guitar.h — CasperakiEngine.cpp:440-456). Every inst-N.json the adapter
// emits with one of these `type` literals MUST have a matching
// `envelope.patterns[0].pattern[*].instrumentId` entry — see the
// patterns-stub invariant block in `toEngineFixture`.
const TONAL_INSTRUMENT_TYPES: ReadonlySet<string> = new Set([
  'basses', // Bass.h
  'leadSynths', // Synths.h
  'synths', // Synths.h
  'keys', // Synths.h
  'popBrass', // Synths.h
  'popStrings', // Synths.h
  'orchestral', // Synths.h
  'vocals', // Synths.h
  'acousticGuitars', // Guitar.h
  'electricGuitars', // Guitar.h
]);

interface MinimalTonalInstJson {
  id: number;
  name?: string;
  type?: string;
  lowLevelType?: string;
}

interface PatternStubEntry {
  bars: Array<{ notes: Record<string, unknown> }>;
  instrumentId: number;
  instrumentName: string;
  instrumentType: string;
  instrumentType1: string;
  patternType: 'instrument';
}

/**
 * Patterns-stub invariant: if `instJson` declares a TonalInstrument
 * `type` (see {@link TONAL_INSTRUMENT_TYPES}) and `patternList` does
 * NOT already carry an entry at the same `instrumentId`, push a stub
 * so the engine's `getInstrumentPattern(songData, inst->id)`
 * (SequencerUtils.h:75) returns a non-undefined value and
 * `TonalInstrument::processSegment` falls through to the per-segment
 * override (TonalInstrument.h:60-67).
 *
 * The stub carries a single empty-notes bar — never read on active
 * segments (override replaces the pattern entirely) and the
 * `barIndex % bars->size()` walk at TonalInstrument.h:83 cannot
 * modulo-by-zero with at least one bar present.
 *
 * Pre-existing entries are left untouched (no duplicates) so the
 * base envelope's Phase-2 Bass/Keys/Pad/Guitar rows stay byte-stable.
 */
function ensureTonalPatternStub(
  patternList: Array<Record<string, unknown>>,
  instJson: unknown,
): void {
  if (instJson === null || typeof instJson !== 'object') return;
  const inst = instJson as MinimalTonalInstJson;
  const instrumentType = inst.type;
  if (typeof instrumentType !== 'string') return;
  if (!TONAL_INSTRUMENT_TYPES.has(instrumentType)) return;
  if (typeof inst.id !== 'number') return;

  for (const entry of patternList) {
    if (entry && typeof entry === 'object' && entry.instrumentId === inst.id) {
      // Pre-existing entry — leave untouched for byte-stability.
      return;
    }
  }

  const stub: PatternStubEntry = {
    bars: [{ notes: {} }],
    instrumentId: inst.id,
    instrumentName: typeof inst.name === 'string' ? inst.name : '',
    instrumentType,
    instrumentType1:
      typeof inst.lowLevelType === 'string' ? inst.lowLevelType : '',
    patternType: 'instrument',
  };
  patternList.push(stub as unknown as Record<string, unknown>);
}

// docs/58 — full drum kit lane → canonical GM MIDI map. The engine's
// `Drums.h` plays every lane present in `overrides.Drums.pattern` (it maps
// each lane name through the kit's `subInstruments`), and the rebuild's
// `inst-1.json` already ships all 17 kit lanes with sample ids — so the
// adapter emits a grid for every lane that carries a hit, not just the
// kick/snare/closed-hat trio. `hiHatPedal` is intentionally omitted: GM
// pins it to MIDI 44, colliding with `hiHatClosed2`, and the legacy
// generators never emit it. Each lane below has a UNIQUE MIDI so the
// MIDI-keyed brain→engine round-trip stays lossless.
const DRUM_MIDI: Record<string, number> = {
  bassDrum1: 36,
  bassDrum2: 35,
  snareDrum1: 38,
  snareDrum2: 40,
  hiHatClosed1: 42,
  hiHatClosed2: 44,
  hiHatOpen: 46,
  ride: 51,
  crash1: 49,
  crash2: 57,
  clap: 39,
  snap: 31,
  shaker: 70,
  tom1: 50,
  tom2: 47,
  tom3: 43,
};

// Defaults for the legacy engine's required `chordType` voicing on chord
// events. Brain `type: 'chord'` events do not carry a voicing tag (the
// `PadBankSelection.style.voicing` lives on the selection object, not the
// note event — see docs/53x §"Unsupported legacy constructs"). The engine's
// `getChordNotes` (SequencerUtils.h:124) throws on an unknown chordType,
// so the adapter must attach one. Keys defaults to a mid-octave piano-style
// voicing; Pad defaults to the brightPop slice's `twoOctavesMid` voicing.
const DEFAULT_KEYS_CHORD_TYPE = 'oneOctaveMid';
const DEFAULT_PAD_CHORD_TYPE = 'twoOctavesMid';
// docs/54z — Synths lane emits only EDMArpeggiator events today (no
// chord events), so the default is informational; supplied for
// hypothetical future chord lowering on this lane.
const DEFAULT_SYNTHS_CHORD_TYPE = 'oneOctaveMid';
// docs/54s — Guitar uses `oneOctaveMid` to land chord voices inside
// the guitarNotes.json multisample range (e2..a#5). Same rationale as
// Keys: getChordNotes throws on a missing chordType, so the adapter
// attaches a deterministic default.
const DEFAULT_GUITAR_CHORD_TYPE = 'oneOctaveMid';

interface EngineStructureBar {
  chords: string[];
}
interface EngineStructureEntry {
  segment: string;
  bars: EngineStructureBar[];
}
interface EngineBassNote {
  type: 'noteAbsolute';
  note: string;
  duration: number;
}
interface EngineBassBar {
  notes: Record<string, EngineBassNote[]>;
}
interface EngineChordNote {
  type: 'chord';
  chord: string;
  chordType: string;
  duration: number;
}
// docs/54t — Guitar fret-noise event passes through to the engine's
// `Guitar.h::createSegmentClip` fret-noise branch via
// `SequencerUtils.h::getFretNoises`. `sounds[i]` is an INDEX into
// the inst's `fx.fxFretNoise[]` array (NOT a MIDI note); the
// remaining fields mirror the legacy `Pop` pattern shape.
interface EngineFretNoiseEvent {
  type: 'fretNoise';
  sounds: number[];
  offset: number[];
  durations: number[];
  velocities: number[];
}
// docs/54v — Guitar virtualGuitarist chord-strum event passes through
// to the engine's `Guitar.h::createSegmentClip` strums branch via
// `SequencerUtils.h::getGuitarStrums`. The engine resolves the
// `(chord, chordPosition, type)` triple against
// `instrumentData["virtualGuitaristSamples"]` (which the adapter
// pre-populates via `collectStrumPoolEntries`). `chord` and
// `chordPosition` on the event are advisory — the engine uses the
// CURRENT chord at the beat position from songStructure, defaulting
// chordPosition to 1 on missing. We still pass them through verbatim
// so the engine's diagnostic logs carry the brain's intent.
interface EngineVirtualGuitaristEvent {
  type: 'virtualGuitarist';
  chord?: string;
  chordPosition?: string;
  event: string;
  duration: number;
}
// docs/54x — Per-string strum event passes through to the engine's
// `SequencerUtils.h::getStrumNotes` (210-257). The engine resolves
// per-string MIDI from `GuitarChord{currentChord}.getLowestPosition()`
// (always `positions[0].midi` per the legacy "lowestPos = 0" rule —
// Chord.h:537-554) and emits one TimeNote per string with the matching
// `offset[i] / durations[i] / velocities[i]`. The `chord` field is
// advisory — engine ignores it for the per-string MIDI lookup but the
// legacy bank carries a chord label per pattern so we preserve it.
interface EngineStrumEvent {
  type: 'strum';
  chord: string;
  strings: number[];
  offset: number[];
  durations: number[];
  velocities: number[];
}
// docs/54z — Synths EDMArpeggiator event. Engine path:
// `SequencerUtils.h::getEDMArpeggiatorNotes` (333-) expands the event
// into per-step TimeNotes using arpeggioType / arpeggioRhythm /
// numberOfOctaves to walk the chord across `numberOfOctaves` octaves
// at the rhythm's step grid. `noteDuration` is the per-step note
// length; `duration` is the overall event window.
interface EngineEDMArpeggiatorEvent {
  type: 'EDMArpeggiator';
  chord: string;
  arpeggioType: string;
  arpeggioRhythm: string;
  numberOfOctaves: number;
  duration: number;
  noteDuration: number;
}
// docs/55a — noteRelative event. Engine path:
// `SequencerUtils.h::getRelativeNote:175-186` reads
// `distanceFromMiddleC` and snaps `Note{60+distanceFromMiddleC}` to
// the segment's current chord nearest note. `chord` on the event is
// INFORMATIONAL — engine uses `currentChord` directly.
interface EngineNoteRelativeEvent {
  type: 'noteRelative';
  chord: string;
  distanceFromMiddleC: number;
  duration: number;
}
// docs/58 — legacy `arpeggio` piano event. Engine path:
// `SequencerUtils.h::getArpeggioNotes:160-178` builds base note
// `C{octave}`, applies the inst octaveAdjustment, then walks the
// current chord in `direction` for `note+1` steps and picks the
// `note`-th. `chord` is informational (engine uses `currentChord`).
interface EngineArpeggioEvent {
  type: 'arpeggio';
  chord: string;
  octave: number;
  direction: string;
  numberOfNotes: number;
  note: number;
  duration: number;
}
type EngineTonalEvent =
  | EngineBassNote
  | EngineChordNote
  | EngineFretNoiseEvent
  | EngineVirtualGuitaristEvent
  | EngineStrumEvent
  | EngineEDMArpeggiatorEvent
  | EngineArpeggioEvent
  | EngineNoteRelativeEvent;
interface EngineTonalBar {
  notes: Record<string, EngineTonalEvent[]>;
}
interface EngineDrumsOverride {
  type: string;
  pattern: Record<string, string>;
}
interface EngineBassOverride {
  type: string;
  bars: EngineBassBar[];
}
interface EngineTonalOverride {
  type: string;
  bars: EngineTonalBar[];
}
interface EngineSegmentArrangement {
  instruments: Record<string, boolean>;
  overrides: Record<
    string,
    EngineDrumsOverride | EngineBassOverride | EngineTonalOverride
  >;
  fills: Record<string, unknown>;
  mutes: Record<string, unknown>;
  signalProcessors: Record<string, unknown>;
  transitions: Record<string, unknown>;
}
interface EngineSong {
  key: string;
  tempo: number;
  genre?: string;
  brainProvenance?: BrainProvenance;
  structure: EngineStructureEntry[];
  arrangement: Record<string, EngineSegmentArrangement>;
  [key: string]: unknown;
}

// ===========================================================================
// Lane model (docs/58 lane-model selection refactor)
// ===========================================================================
//
// The brain no longer emits a fixed role bundle (Bass / Keys / Pad / Synths /
// …). It emits a probabilistic per-song roster where each tonal *lane* is an
// `instrumentDefinitions[]` entry. Lanes of the same catalog family carry a
// ` 2` / ` 3` suffix on `name` (e.g. `Synths`, `Synths 2`, `Synths 3`) and
// per-segment add-on lanes appear only in the segments they're active on.
//
// The adapter discovers every tonal lane generically and emits one
// inst-N.json per lane (builder chosen by the catalog `instrumentGroup`),
// instead of the old fixed display-name scan that silently dropped
// duplicate-family + add-on lanes.
//
// Builder routing by catalog family (`instrumentGroup`):
//   basses                         → bass    (base-bass fixture, Bass.h)
//   keys                           → keys    (base-keys fixture, Synths.h)
//   pads | synths+synths{Soft,Bright}Pad → pad (base-pad fixture, Synths.h)
//   synths+synthsPlucked           → plucked (parametric, Synths.h)
//   leadSynths                     → synths  (parametric, Synths.h)
//   acoustic/electricGuitars       → guitar  (parametric, Guitar.h)
//   popStrings                     → strings (parametric, Synths.h)
//   popBrass                       → brass   (parametric, Synths.h)
// Anything else (kickDrums, Vocal, percussion, …) → not a tonal lane.

type LaneBuilderKind =
  | 'bass'
  | 'keys'
  | 'pad'
  | 'plucked'
  | 'synths'
  | 'guitar'
  | 'strings'
  | 'brass';

const FIXTURE_KINDS: ReadonlySet<LaneBuilderKind> = new Set(['bass', 'keys', 'pad']);

interface KindConfig {
  /** canonical inst-N.json filename slot for occurrence 0 of this kind. */
  slot: number;
  /** canonical engine wrapper (vst) id for occurrence 0. */
  vstId: number;
  /** canonical first multisample id for occurrence 0. */
  sampleBase: number;
}

// Occurrence-0 of each kind keeps the canonical slot/id the base envelope's
// patterns[] table + the prestage scripts already know (Bass=2/38842,
// Keys=3/38907, Pad=4/38972, Guitar=5/39111, Synths=6/39140, …). This makes
// the primary lane byte-stable with the pre-lane-model output. Duplicates
// (occurrence > 0) get fresh ids from the DUP_* ranges below.
const KIND_CONFIG: Record<LaneBuilderKind, KindConfig> = {
  bass: { slot: 2, vstId: 38842, sampleBase: 945 },
  keys: { slot: 3, vstId: 38907, sampleBase: 2048 },
  pad: { slot: 4, vstId: 38972, sampleBase: 3153 },
  guitar: { slot: 5, vstId: DEFAULT_GUITAR_VST_ID, sampleBase: DEFAULT_GUITAR_SAMPLE_ID_BASE },
  synths: { slot: 6, vstId: DEFAULT_SYNTHS_VST_ID, sampleBase: DEFAULT_SYNTHS_SAMPLE_ID_BASE },
  plucked: { slot: 7, vstId: DEFAULT_PLUCKED_SYNTHS_VST_ID, sampleBase: DEFAULT_PLUCKED_SYNTHS_SAMPLE_ID_BASE },
  strings: { slot: 8, vstId: DEFAULT_POP_STRINGS_VST_ID, sampleBase: DEFAULT_POP_STRINGS_SAMPLE_ID_BASE },
  brass: { slot: 9, vstId: DEFAULT_POP_BRASS_VST_ID, sampleBase: DEFAULT_POP_BRASS_SAMPLE_ID_BASE },
};

// Duplicate-lane allocation. Each occurrence>0 lane gets a 1000-wide sample
// block (room for guitar's 30 notes + 8 fret-noise + strum pool) and one
// fresh wrapper id + filename slot. All ranges stay clear of every canonical
// id, the transition base (40000), and the loop base (50000).
const DUP_VST_BASE = 39300;
const DUP_SLOT_BASE = 10;
const DUP_SAMPLE_BASE = 10000;
const DUP_SAMPLE_BLOCK = 1000;

const CHORD_TYPE_BY_KIND: Record<LaneBuilderKind, string> = {
  bass: DEFAULT_KEYS_CHORD_TYPE, // unused — bass lowers via bassBarsFromBrainBars
  keys: DEFAULT_KEYS_CHORD_TYPE,
  pad: DEFAULT_PAD_CHORD_TYPE,
  guitar: DEFAULT_GUITAR_CHORD_TYPE,
  synths: DEFAULT_SYNTHS_CHORD_TYPE,
  plucked: DEFAULT_SYNTHS_CHORD_TYPE,
  strings: DEFAULT_SYNTHS_CHORD_TYPE,
  brass: DEFAULT_SYNTHS_CHORD_TYPE,
};

/** Map a catalog family (`instrumentGroup`) + lowLevel to a builder kind.
 *  Returns undefined for non-tonal families (drums / Vocal / percussion). */
function kindFromGroup(
  group: string | undefined,
  lowLevel: string | undefined,
): LaneBuilderKind | undefined {
  switch (group) {
    case 'basses':
      return 'bass';
    case 'keys':
      return 'keys';
    case 'pads':
      return 'pad';
    case 'leadSynths':
      return 'synths';
    case 'synths':
      return typeof lowLevel === 'string' && /pluck/i.test(lowLevel) ? 'plucked' : 'pad';
    case 'acousticGuitars':
    case 'electricGuitars':
      return 'guitar';
    case 'popStrings':
      return 'strings';
    case 'popBrass':
      return 'brass';
    default:
      return undefined;
  }
}

/** Back-compat fallback for lanes that appear in `arrangement` overrides
 *  without a matching `instrumentDefinitions` entry (the hand-built Song
 *  stand-ins in unit tests). Keyed on the legacy display name (strip the
 *  ` 2` / ` 3` duplicate suffix). Returns undefined for non-tonal lanes
 *  (Drums / Loop / Vocal), which are emitted by their own dedicated paths. */
function kindFromLegacyName(name: string): LaneBuilderKind | undefined {
  switch (name.replace(/\s+\d+$/, '')) {
    case 'Bass':
      return 'bass';
    case 'Keys':
      return 'keys';
    case 'Pad':
      return 'pad';
    case 'Guitar':
      return 'guitar';
    case 'Synths':
      return 'synths';
    case 'PluckedSynths':
      return 'plucked';
    case 'PopStrings':
      return 'strings';
    case 'PopBrass':
      return 'brass';
    default:
      return undefined;
  }
}

interface TonalLane {
  /** lane display name = arrangement override/instruments key + emitted
   *  inst `name`. The base family name, with a ` 2` / ` 3` suffix for
   *  duplicate-family lanes. */
  name: string;
  kind: LaneBuilderKind;
  /** the brain's InstrumentDefinition for this lane, when present. Absent
   *  only for the override-key-only back-compat path. */
  def?: InstrumentDefinition;
}

/** Discover every tonal lane the engine should render: the union of the
 *  song's tonal `instrumentDefinitions` (authoritative kind via
 *  `instrumentGroup`) and any tonal lane that appears only as an
 *  `arrangement[seg].overrides` key (kind inferred from the legacy display
 *  name). Deterministic: definition order first, then first-seen override
 *  keys. */
function discoverTonalLanes(song: Song): TonalLane[] {
  const byName = new Map<string, TonalLane>();
  for (const def of song.instrumentDefinitions ?? []) {
    if (!def || typeof def.name !== 'string') continue;
    const kind = kindFromGroup(
      typeof def.instrumentGroup === 'string' ? def.instrumentGroup : undefined,
      typeof def.lowLevelType === 'string' ? def.lowLevelType : undefined,
    );
    if (!kind) continue;
    if (!byName.has(def.name)) byName.set(def.name, { name: def.name, kind, def });
  }
  for (const seg of song.songStructure ?? []) {
    const ar = (song.arrangement ?? {})[seg.name];
    const overrides = (ar?.overrides ?? {}) as Record<string, unknown>;
    for (const name of Object.keys(overrides)) {
      if (byName.has(name)) continue;
      const kind = kindFromLegacyName(name);
      if (!kind) continue;
      byName.set(name, { name, kind });
    }
  }
  return [...byName.values()];
}

interface AllocatedLane extends TonalLane {
  /** occurrence index of this kind across the song (0 = primary). */
  occurrence: number;
  vstId: number;
  sampleBase: number;
  slot: number;
  filename: string;
  /** guitar only. */
  fretNoiseBase: number;
  strumBase: number;
}

/** Assign each active lane a unique wrapper id + sample range + inst-N.json
 *  filename slot. Occurrence-0 of a kind keeps its canonical ids (byte-stable
 *  with the pre-lane-model output); duplicates draw from the DUP_* ranges. */
function allocateLanes(activeLanes: readonly TonalLane[]): AllocatedLane[] {
  const occurrenceByKind = new Map<LaneBuilderKind, number>();
  let dup = 0;
  const out: AllocatedLane[] = [];
  for (const lane of activeLanes) {
    const occ = occurrenceByKind.get(lane.kind) ?? 0;
    occurrenceByKind.set(lane.kind, occ + 1);
    const cfg = KIND_CONFIG[lane.kind];
    let vstId: number;
    let sampleBase: number;
    let slot: number;
    let fretNoiseBase: number;
    let strumBase: number;
    if (occ === 0) {
      vstId = cfg.vstId;
      sampleBase = cfg.sampleBase;
      slot = cfg.slot;
      fretNoiseBase = DEFAULT_GUITAR_FRET_NOISE_ID_BASE;
      strumBase = DEFAULT_GUITAR_STRUM_ID_BASE;
    } else {
      const d = dup++;
      vstId = DUP_VST_BASE + d;
      slot = DUP_SLOT_BASE + d;
      sampleBase = DUP_SAMPLE_BASE + d * DUP_SAMPLE_BLOCK;
      fretNoiseBase = sampleBase + 100;
      strumBase = sampleBase + 200;
    }
    out.push({
      ...lane,
      occurrence: occ,
      vstId,
      sampleBase,
      slot,
      filename: `inst-${slot}.json`,
      fretNoiseBase,
      strumBase,
    });
  }
  return out;
}

/** Build the engine inst-N.json for a single tonal lane, dispatching on the
 *  lane's builder kind. The parametric builders (synths / plucked / guitar /
 *  orchestral) already key lowLevelType + catalogId off the lane's def; the
 *  fixture builders (bass / keys / pad) clone the Phase-2 wrapper and remap
 *  its sample ids. The emitted inst `name` is always the lane name so the
 *  engine's per-segment override/instruments lookup (keyed by name) resolves
 *  the right lane, including duplicates. */
function buildLaneInst(
  lane: AllocatedLane,
  song: Song,
  options: ToEngineFixtureOptions,
): InstrumentEnvelopeFile {
  const filenameIndex = lane.slot;
  switch (lane.kind) {
    case 'bass':
      return buildFixtureLaneInst(lane, BASE_BASS_INST, fixtureResolutionFor(lane, options));
    case 'keys':
      return buildFixtureLaneInst(lane, BASE_KEYS_INST, fixtureResolutionFor(lane, options));
    case 'pad':
      return buildFixtureLaneInst(lane, BASE_PAD_INST, fixtureResolutionFor(lane, options));
    case 'synths': {
      const built = buildSynthsInst({ def: lane.def!, vstId: lane.vstId, sampleIdBase: lane.sampleBase, filenameIndex });
      return finishParametricLaneInst(lane, built);
    }
    case 'plucked': {
      const built = buildPluckedSynthsInst({ def: lane.def!, vstId: lane.vstId, sampleIdBase: lane.sampleBase, filenameIndex });
      return finishParametricLaneInst(lane, built);
    }
    case 'strings': {
      const built = buildPopStringsInst({ def: lane.def!, vstId: lane.vstId, sampleIdBase: lane.sampleBase, filenameIndex });
      return finishParametricLaneInst(lane, built);
    }
    case 'brass': {
      const built = buildPopBrassInst({ def: lane.def!, vstId: lane.vstId, sampleIdBase: lane.sampleBase, filenameIndex });
      return finishParametricLaneInst(lane, built);
    }
    case 'guitar': {
      const strumPool = collectStrumPoolEntries(song, lane.strumBase, lane.name);
      const built = buildGuitarInst({
        def: lane.def!,
        vstId: lane.vstId,
        sampleIdBase: lane.sampleBase,
        fretNoiseIdBase: lane.fretNoiseBase,
        fretNoiseCount: DEFAULT_GUITAR_FRET_NOISE_COUNT,
        strumPool,
        filenameIndex,
      });
      return finishParametricLaneInst(lane, built);
    }
  }
}

/** Pick the asset-resolver verdict (lowLevelType + octave source) for a
 *  primary fixture lane. Only Bass/Keys/Pad occurrence-0 read these — the
 *  render path resolves exactly those three families. Duplicates + add-on
 *  fixture lanes fall through to their def's lowLevelType in
 *  buildFixtureLaneInst. */
function fixtureResolutionFor(
  lane: AllocatedLane,
  options: ToEngineFixtureOptions,
): AssetResolutionInfo | undefined {
  if (lane.occurrence !== 0) return undefined;
  switch (lane.kind) {
    case 'bass':
      return options.bassAssetResolution;
    case 'keys':
      return options.keysAssetResolution;
    case 'pad':
      return options.padAssetResolution;
    default:
      return undefined;
  }
}

/** Clone a Phase-2 fixture wrapper (base-{bass,keys,pad}-inst.json) for one
 *  fixture-kind lane: repoint the wrapper id, remap the sample ids onto the
 *  lane's range, set the lane name. For the primary lane the lowLevelType +
 *  octaveAdjustment track the resolver verdict (byte-stable with the
 *  pre-lane-model path); for duplicate / add-on lanes they track the lane's
 *  own def so the engine's family-keyed mixing/FX routing follows the
 *  selection. */
function buildFixtureLaneInst(
  lane: AllocatedLane,
  fixtureSource: string,
  resolution: AssetResolutionInfo | undefined,
): InstrumentEnvelopeFile {
  const json = JSON.parse(fixtureSource) as {
    id: number;
    name: string;
    shortName?: string;
    lowLevelType?: string;
    catalogId?: string | number;
    samples: Array<{ id: number; vst: number }>;
  };
  json.id = lane.vstId;
  json.name = lane.name;
  let nextId = lane.sampleBase;
  for (const s of json.samples) {
    s.id = nextId++;
    s.vst = lane.vstId;
  }
  if (lane.occurrence === 0) {
    // Primary lane: keep the fixture default lowLevelType unless the resolver
    // resolved a row; octave tracks the resolver entry id. Byte-identical to
    // the pre-lane-model emission.
    setResolvedLowLevelType(json, resolution);
    setOctaveAdjustment(json, resolution?.entryId);
  } else {
    if (typeof lane.def?.lowLevelType === 'string' && lane.def.lowLevelType.length > 0) {
      json.lowLevelType = lane.def.lowLevelType;
    }
    if (typeof lane.def?.shortName === 'string' && lane.def.shortName.length > 0) {
      json.shortName = lane.def.shortName;
    }
    if (lane.def?.id !== undefined) json.catalogId = lane.def.id;
    setOctaveAdjustment(json, lane.def?.id as string | undefined);
  }
  return { filename: lane.filename, json };
}

/** Finish a parametric-builder inst: stamp the lane name (overriding the
 *  builder's hardcoded family-name literal so duplicate lanes carry
 *  `Synths 2` etc.) and set octaveAdjustment from the lane's catalog row. */
function finishParametricLaneInst(
  lane: AllocatedLane,
  built: { filename: string; json: { name: string; catalogId?: string | number } },
): InstrumentEnvelopeFile {
  built.json.name = lane.name;
  setOctaveAdjustment(built.json, lane.def?.id as string | undefined);
  return { filename: built.filename, json: built.json };
}

/**
 * Lower a canonical Casperaki Song into the legacy engine envelope.
 *
 * The lowering walks the brain's full `songStructure`, emitting a matching
 * engine structure entry + arrangement block per segment. Drums / Bass /
 * Keys / Pad overrides are lowered when the brain provides them on a
 * segment; the per-segment `instruments` flag is taken straight from the
 * brain's `arrangement.<segment>.instruments` map (defaulting unspecified
 * families to `false` so the engine doesn't fall back to the global
 * `patterns` block — `isInstrumentInSegment` defaults to true on a missing
 * property, see sequencer/Sequencer.cpp:45).
 *
 * fills are passed through verbatim from brain 53aa (engine reads them
 * via Sequencer.cpp:103 → Drums.h::applyFill — see docs/54o).
 *
 * transitions are lowered into per-segment `transitions.<inst-name>`
 * blocks + matching transitionSample inst-N.json files IFF the caller
 * provides `transitionCatalog` + `getTransitionSampleDurationSeconds`.
 * Without those options the adapter emits empty `transitions: {}`
 * (back-compat). See docs/54p.
 *
 * signalProcessors are lowered when the brain emits a supported tag
 * (`lowPassFilter*` family) — see docs/54q. Unsupported tags pass through
 * verbatim so the engine's `applySignalProcessor` returns early.
 *
 * Vocals, mutes, and TransitionNoise / TransitionPattern are still
 * deferred — those blocks are emitted as empty `{}` per segment so the
 * engine walks past them. See file header for per-lane status.
 */
export function toEngineFixture(
  song: Song,
  options: ToEngineFixtureOptions,
): EngineFixture {
  const diagnostics: AdapterDiagnostic[] = [];
  const envelope = JSON.parse(BASE_ENGINE_SONG) as EngineSong;

  envelope.tempo = song.bpm;
  envelope.key = song.key;
  if (song.genre !== undefined) envelope.genre = song.genre;
  envelope.brainProvenance = {
    generator: options.generatorName ?? DEFAULT_GENERATOR_NAME,
    hash: options.brainHash,
    params: options.generatorParams,
  };

  const segments = song.songStructure ?? [];
  if (segments.length === 0) {
    throw new Error('engine-adapter: brain Song has no songStructure entries');
  }

  // Discover every tonal lane the brain emitted (lane model — docs/58).
  // Lanes are the union of the song's tonal instrumentDefinitions and any
  // tonal arrangement override key. A lane is "active" iff at least one
  // segment carries a non-empty override for it; only active lanes get a
  // global inst-N.json (keeps the artefact set minimal + matches the
  // engine's addInstrument expectation). Each active lane is allocated a
  // unique wrapper id + sample range + inst-N.json slot — primary lanes
  // keep the canonical ids, duplicate-family lanes (Synths 2, …) get fresh
  // ones — so the new model renders fully instead of silently dropping
  // duplicate + add-on lanes the way the old fixed display-name scan did.
  const allLanes = discoverTonalLanes(song);
  let drumsHasAnyHit = false;
  let totalBars = 0;
  for (const seg of segments) {
    totalBars += seg.bars?.length ?? 0;
    const drumOv = (((song.arrangement ?? {})[seg.name])?.overrides as
      | Record<string, BrainOverride>
      | undefined)?.Drums;
    if (drumBarsHaveAnyHit(drumOv?.bars ?? [])) drumsHasAnyHit = true;
  }
  // Drums is always emitted as inst-1.json (the engine's drum-kit
  // constructor needs the 17-id sub-instrument set even when nothing is
  // active in any segment).
  void drumsHasAnyHit;
  const laneActiveAnywhere = (lane: TonalLane): boolean =>
    segments.some((seg) => {
      const ov = (((song.arrangement ?? {})[seg.name])?.overrides as
        | Record<string, BrainOverride>
        | undefined)?.[lane.name];
      return tonalBarsHaveAnyEvent(ov?.bars ?? []);
    });
  const activeLanes = allLanes.filter(laneActiveAnywhere);
  const inactiveLanes = allLanes.filter((l) => !activeLanes.includes(l));
  const lanes = allocateLanes(activeLanes);

  // ---- Build the multi-segment structure + arrangement -------------------
  envelope.structure = segments.map((seg) => ({
    segment: seg.name,
    bars: (seg.bars ?? []).map((bar) => ({
      chords: [...((bar as { chords?: string[] }).chords ?? [])],
    })),
  }));

  const perSegmentSummary: Array<{
    segment: string;
    bars: number;
    active: string[];
  }> = [];
  // docs/54q — SP lowering summary (collected per segment, surfaced as a
  // diagnostic after the loop).
  const signalProcessorsLowered: Array<{ segment: string; display: string; tag: string; points: number }> = [];
  const signalProcessorsDropped: Array<{ segment: string; display: string; tag: string }> = [];
  const newArrangement: Record<string, EngineSegmentArrangement> = {};
  for (const seg of segments) {
    const brainAr = ((song.arrangement ?? {})[seg.name] ?? {}) as BrainSegmentArrangement;
    const brainInstr = (brainAr.instruments ?? {}) as Record<string, boolean>;
    const brainOverrides = (brainAr.overrides ?? {}) as Record<string, BrainOverride>;
    // Step 16 (docs/53aa) emits per-segment fills under
    // `arrangement[seg].fills.<Display>`. The engine reads them at
    // render time via Sequencer.cpp:103 → Drums.h::applyFill. The
    // adapter pre-54o wrote empty `{}`, silently dropping every fill
    // the brain emitted. Pass through verbatim — verified audible in
    // docs/54o (bar-by-bar RMS bump on `patternEndOfSegment` slot).
    const brainFills = (brainAr.fills ?? {}) as Record<string, unknown>;

    // docs/54q — brain 53aa emits `signalProcessors.<Display> = {type}`
    // for `break` / `bridge` segments. Engine expects the expanded
    // `{type, lowPassFilter: [{pointIn32ndNotes, pointInSeconds, value}]}`
    // shape (Instrument.cpp:28-72). Expand here via the ported
    // EffectsClass.getEffect; unsupported tags pass through verbatim
    // so the engine sees no `lowPassFilter[]` and `applySignalProcessor`
    // returns early.
    const brainSP = (brainAr.signalProcessors ?? {}) as Record<string, { type?: string } | undefined>;
    const loweredSP: Record<string, unknown> = {};
    const segBarsLen = seg.bars?.length ?? 0;
    for (const [display, entry] of Object.entries(brainSP)) {
      if (!entry) continue;
      const tag = typeof entry.type === 'string' ? entry.type : '';
      if (!tag) {
        loweredSP[display] = entry;
        continue;
      }
      if (!isSupportedSignalProcessorTag(tag)) {
        loweredSP[display] = entry;
        signalProcessorsDropped.push({ segment: seg.name, display, tag });
        continue;
      }
      const block = computeSignalProcessor({ tag, segmentLengthInBars: segBarsLen, tempo: song.bpm });
      if (!block) {
        loweredSP[display] = entry;
        signalProcessorsDropped.push({ segment: seg.name, display, tag });
        continue;
      }
      loweredSP[display] = block;
      signalProcessorsLowered.push({
        segment: seg.name,
        display,
        tag,
        points: (block.lowPassFilter ?? block.volume ?? []).length,
      });
    }

    const segArr: EngineSegmentArrangement = {
      instruments: {},
      overrides: {},
      fills: { ...brainFills },
      mutes: {},
      signalProcessors: loweredSP,
      transitions: {},
    };

    // Set the instruments map explicitly. `isInstrumentInSegment` defaults
    // to TRUE on a missing entry (sequencer/Sequencer.cpp:45-47), so we
    // must list every emitted family — true to activate, false to silence
    // it for the segment. Vocals are intentionally absent (deferred).
    const drumsBars = brainOverrides.Drums?.bars ?? [];
    const drumsActive = brainInstr.Drums !== false && drumBarsHaveAnyHit(drumsBars);
    segArr.instruments[DRUMS_DISPLAY_NAME] = drumsActive;

    if (drumsActive) {
      // Emit a grid for every kit lane the brain bars actually hit. An
      // all-zero lane is omitted so the engine never opens a silent channel
      // for it (docs/58 widened-kit lowering).
      const pattern: Record<string, string> = {};
      for (const [lane, midi] of Object.entries(DRUM_MIDI)) {
        const grid = gridFromBrainBars(drumsBars, midi);
        if (grid.includes('x')) pattern[lane] = grid;
      }
      segArr.overrides[DRUMS_DISPLAY_NAME] = {
        type: 'brainRoundtrip',
        pattern,
      };
    }

    // Tonal lanes — generic per-lane activation + override projection
    // (lane model, docs/58). A lane is active in this segment iff the brain
    // flag is not an explicit `false` AND the segment carries at least one
    // chord/note event. Bass lowers to noteAbsolute (cancels chord
    // transposition); every other kind lowers chord/note events with its
    // default chordType voicing.
    for (const lane of lanes) {
      const laneBars = brainOverrides[lane.name]?.bars ?? [];
      const active = brainInstr[lane.name] !== false && tonalBarsHaveAnyEvent(laneBars);
      segArr.instruments[lane.name] = active;
      if (!active) continue;
      segArr.overrides[lane.name] = {
        type: 'brainRoundtrip',
        bars:
          lane.kind === 'bass'
            ? bassBarsFromBrainBars(laneBars)
            : tonalBarsFromBrainBars(laneBars, CHORD_TYPE_BY_KIND[lane.kind]),
      };
    }

    newArrangement[seg.name] = segArr;
    perSegmentSummary.push({
      segment: seg.name,
      bars: seg.bars?.length ?? 0,
      active: Object.entries(segArr.instruments)
        .filter(([, v]) => v)
        .map(([k]) => k),
    });
  }
  envelope.arrangement = newArrangement;

  // ---- Emit inst-N.json files -------------------------------------------
  const instruments: InstrumentEnvelopeFile[] = [
    { filename: 'inst-1.json', json: JSON.parse(BASE_DRUMS_INST) },
  ];

  // Next inst-N.json filename index — derived from the HIGHEST filename
  // index already emitted, NOT `instruments.length`. The fixed tonal
  // slots (Bass=2, Keys=3, Pad=4) are emitted by hardcoded filename and
  // leave gaps when a lane is inactive, so the array length runs behind
  // the highest slot. Using the length let a dynamically-indexed lane
  // (Guitar/Synths/PluckedSynths/transitions/Loop) reuse a gap-shadowed
  // slot and clobber an already-emitted file — e.g. a song with Pad
  // active but Keys inactive (schlager) put Synths on Pad's inst-4.json
  // and silently dropped the Pad. Max-based indexing is gap-tolerant and
  // collision-free regardless of which tonal lanes are active.
  const nextInstIndex = (): number =>
    instruments.reduce((mx, i) => {
      const m = /^inst-(\d+)\.json$/.exec(i.filename);
      return m ? Math.max(mx, Number(m[1])) : mx;
    }, 0) + 1;
  // ---- Tonal lane inst emission (lane model, docs/58) -------------------
  // One inst-N.json per active tonal lane, the builder chosen by the lane's
  // catalog family. Primary lanes keep their canonical filename slot
  // (Bass=2, Keys=3, Pad=4, Guitar=5, Synths=6, PluckedSynths=7,
  // PopStrings=8, PopBrass=9); duplicate-family lanes (Synths 2, …) land at
  // slot 10+. Drums stays inst-1. Transitions + loops continue from
  // nextInstIndex() below.
  for (const lane of lanes) {
    instruments.push(buildLaneInst(lane, song, options));
  }

  // ---- TonalInstrument patterns[] stub invariant ----------------------
  //
  // ENGINE CONTRACT (docs/56b §"Engine patterns[] gap", docs/54w):
  // `TonalInstrument::processSegment` (TonalInstrument.h:36-43) starts
  // with
  //     j::var pattern = getInstrumentPattern (songData, inst->id);
  //     if (pattern.isUndefined()) return;
  // BEFORE consulting the per-segment override (TonalInstrument.h:60-67
  // sets `pattern = override` AFTER this early return). So every
  // TonalInstrument-derived inst the adapter emits (engine routes
  // `basses` → Bass.h, `leadSynths`/`synths`/`keys`/`popBrass`/
  // `popStrings`/`orchestral`/`vocals` → Synths.h, `acousticGuitars`/
  // `electricGuitars` → Guitar.h — CasperakiEngine.cpp:440-456) MUST
  // have a matching entry at `envelope.patterns[0].pattern[*]
  // .instrumentId`, or all of its per-segment overrides are silently
  // dropped on the floor.
  //
  // The base envelope (fixtures/base-engine-song.json) historically
  // ships Phase-2 pattern entries for Drums=100, Bass=38842, Pad=38972,
  // Keys=38907, Guitar=39111, Loop=31384/37297. Synths (id=39140) and
  // PluckedSynths (id=39160) — introduced in 54z/55a — had no matching
  // entry and produced bit-identical output when their events were
  // stripped (56b diagnosis). The invariant below ensures we never
  // re-introduce that bug for any new tonal lane: walk every emitted
  // inst whose `type` is in TONAL_INSTRUMENT_TYPES, and push a stub
  // entry to patterns[0].pattern iff no entry for that instrumentId
  // already exists. Pre-existing entries are left untouched (Bass/Keys/
  // Pad/Guitar in the base fixture stay byte-stable).
  //
  // The stub's bars MUST carry at least one entry — the engine walks
  // pattern bars with `patternBarIndex = barIndex % bars->size()`
  // (TonalInstrument.h:83) which is modulo-by-zero (→ SIGSEGV) on an
  // empty bars array. A single empty-notes bar is sufficient: it is
  // never read on segments the brain activated (override replaces the
  // pattern wholesale) and is a safe no-op on the fallback path where
  // `isInstrumentInSegment` defaults true (Sequencer.cpp:45).
  const basePatternBundle = (envelope as unknown as {
    patterns?: Array<{ pattern?: Array<Record<string, unknown>> }>;
  }).patterns;
  const patternList = basePatternBundle?.[0]?.pattern;
  const tonalStubs: Array<{ added: boolean; id: number; type: string; name: string }> = [];
  if (Array.isArray(patternList)) {
    for (const inst of instruments) {
      const before = patternList.length;
      ensureTonalPatternStub(patternList, inst.json);
      const j = inst.json as MinimalTonalInstJson;
      if (typeof j?.id === 'number' && typeof j?.type === 'string' && TONAL_INSTRUMENT_TYPES.has(j.type)) {
        tonalStubs.push({
          added: patternList.length > before,
          id: j.id,
          type: j.type,
          name: typeof j.name === 'string' ? j.name : '',
        });
      }
    }
  }

  // ---- Transition lowering (docs/54p) ----------------------------------
  // Brain 53aa emits `arrangement[seg].transitions.<tag> = {type, placement}`
  // for anchor segments. Engine reads
  // `arrangement[seg].transitions.<inst-display-name>` with the
  // fully-resolved {id, sequenceStartPosition, ..., urls} shape, plus a
  // matching inst-N.json (type='transitionSample'). Resolve when the
  // caller passes a catalog + duration-probe callback.
  const transitionSummary: Array<{
    segment: string;
    tag: string;
    catalogId: string;
    source: 'genre' | 'fallback';
    startPos32: number;
    duration: number;
  }> = [];
  const transitionsDropped: Array<{ segment: string; tag: string; reason: string }> = [];

  if (options.transitionCatalog && options.getTransitionSampleDurationSeconds) {
    const cat = options.transitionCatalog;
    const probe = options.getTransitionSampleDurationSeconds;
    const genre = song.genre ?? 'brightPop';
    let nextId = options.transitionPlaysampleIdBase ?? 40000;
    let nextFilenameIdx = options.transitionInstFilenameStart ?? nextInstIndex();
    const tempo = song.bpm;
    const beatSec = 60 / tempo;
    const barSec = beatSec * 4;

    for (const seg of segments) {
      const segBars = seg.bars?.length ?? 0;
      const segDurSec = segBars * barSec;
      const brainTransitions = (((song.arrangement ?? {})[seg.name] ?? {}) as BrainSegmentArrangement)
        .transitions as Record<string, { type?: string; placement?: string } | undefined> | undefined;
      if (!brainTransitions) continue;

      // Deterministic per-segment order — alphabetical by tag.
      const tags = Object.keys(brainTransitions).sort();
      for (const tag of tags) {
        const entry = brainTransitions[tag];
        if (!entry) continue;

        // edmSnareDrumRoll is a TransitionPattern (two-sample step grid), not a
        // one-shot TransitionSample — it carries the brain-generated grid and
        // is lowered through a distinct path (docs/54n; engine
        // TransitionPattern.h).
        if (tag === EDM_SNARE_DRUM_ROLL_TAG) {
          const rollEntry = entry as { pattern?: Record<string, string>; lengthInBars?: number };
          if (!rollEntry.pattern || typeof rollEntry.lengthInBars !== 'number') {
            transitionsDropped.push({ segment: seg.name, tag, reason: 'edmSnareDrumRoll entry missing pattern/lengthInBars (brain did not attach a grid)' });
            continue;
          }
          const snares = resolveSnareRollSamples({ catalog: cat, segmentName: seg.name, seed: options.brainHash });
          if (!snares) {
            transitionsDropped.push({ segment: seg.name, tag, reason: 'no snareDrumsElectronic catalog rows' });
            continue;
          }
          const rollTiming = computeSnareRollTiming({ segmentDurationSeconds: segDurSec, tempo, lengthInBars: rollEntry.lengthInBars });
          const instId = nextId++;
          const sampleId0 = nextId++;
          const sampleId1 = nextId++;
          const builtRoll = buildSnareRollPatternAssets({
            segmentName: seg.name, instId, sampleIds: [sampleId0, sampleId1],
            filenameIndex: nextFilenameIdx++, samples: snares,
            pattern: rollEntry.pattern, lengthInBars: rollEntry.lengthInBars, timing: rollTiming,
          });
          instruments.push({ filename: builtRoll.inst.filename, json: builtRoll.inst.json });
          const rollSegArr = newArrangement[seg.name];
          if (rollSegArr) {
            (rollSegArr.transitions as Record<string, unknown>)[builtRoll.blockKey] = builtRoll.block;
            (rollSegArr.instruments as Record<string, boolean>)[builtRoll.blockKey] = true;
          }
          transitionSummary.push({
            segment: seg.name, tag,
            catalogId: snares.rows[0].id, source: snares.source,
            startPos32: rollTiming.sequenceStartPosition, duration: 0,
          });
          continue;
        }

        if (!TRANSITION_TAG_TO_LOW_LEVEL[tag]) {
          transitionsDropped.push({ segment: seg.name, tag, reason: 'tag not in TRANSITION_TAG_TO_LOW_LEVEL (unsupported lane)' });
          continue;
        }
        const resolved = resolveTransitionRow({
          catalog: cat, tag, segmentName: seg.name, genre, seed: options.brainHash,
          // percussionBreaks* are bpm-matched (one pre-rendered row per integer
          // bpm; no live time-stretch) — pass song tempo so the resolver picks
          // the song-tempo variant (legacy TransitionsClass.js:457).
          tempo,
          // Tonal transitions (fxTonalReverse) are key-matched, not
          // pitch-shifted — pass the segment's final-chord root so the
          // resolver picks the recording in the song's key (docs/54p +
          // legacy TransitionsClass.js:349).
          finalChordRoot: finalChordRootForSegment(
            seg.bars as ReadonlyArray<{ chords?: readonly string[] }> | undefined,
          ),
        });
        if (!resolved) {
          transitionsDropped.push({ segment: seg.name, tag, reason: 'no catalog row for (family, lowLevel)' });
          continue;
        }
        const durSec = probe(resolved.entry);
        if (durSec === null || !Number.isFinite(durSec) || durSec <= 0) {
          transitionsDropped.push({ segment: seg.name, tag, reason: `duration probe failed (entry id=${resolved.entry.id})` });
          continue;
        }
        // docs/58d + 58e — three-tier lookup:
        // per-catalog-row → per-lowLevel → attack-vs-tail heuristic.
        const climaxSec = TRANSITION_CLIMAX_BY_CATALOG_ID.get(resolved.entry.id)
          ?? TRANSITION_CLIMAX_BY_LOWLEVEL.get(resolved.entry.lowLevel)
          ?? defaultClimaxForTag(tag, durSec);
        const placement = (entry.placement === 'beginningOfSegment' || entry.placement === 'midSegment' || entry.placement === 'endOfSegment')
          ? entry.placement : undefined;
        const timing = computeTransitionTiming({
          tag, segmentDurationSeconds: segDurSec, sampleDurationSeconds: durSec,
          sampleClimaxSeconds: climaxSec, tempo, placement,
        });
        const built = buildTransitionAssets({
          tag, segmentName: seg.name,
          playsampleId: nextId++,
          filenameIndex: nextFilenameIdx++,
          resolvedRow: resolved, timing,
          sampleDurationSeconds: durSec, sampleClimaxSeconds: climaxSec,
        });
        instruments.push({ filename: built.inst.filename, json: built.inst.json });
        const segArr = newArrangement[seg.name];
        if (segArr) {
          (segArr.transitions as Record<string, unknown>)[built.blockKey] = built.block;
          // Engine reads `isInstrumentInSegment` via the per-segment
          // `instruments` map; transitionSamples must be marked true on
          // the segments they activate. Sequencer.cpp's per-instrument
          // loop checks this before invoking processSegment.
          (segArr.instruments as Record<string, boolean>)[built.blockKey] = true;
        }
        transitionSummary.push({
          segment: seg.name, tag,
          catalogId: resolved.entry.id, source: resolved.source,
          startPos32: timing.sequenceStartPosition, duration: durSec,
        });
      }
    }
  }

  // ---- fxNoiseRise lowering (docs/62 A7) -------------------------------
  // The brain emits `transitions.fxNoiseRise = {type, placement}`; expand it
  // into the legacy EffectsClass.getEffect('fxNoiseRise') param object (start
  // position + attack/decay durations + freq sweep + dB envelope) that the WASM
  // engine's `resolveNoiseRises` reads to build a synthesized transitionNoise
  // riser. Synthesized → needs no sample catalog (runs regardless of the
  // catalog-gated transition loop above).
  {
    const tempo = song.bpm;
    for (const seg of segments) {
      const segBars = seg.bars?.length ?? 0;
      if (segBars <= 0) continue;
      const brainTransitions = (((song.arrangement ?? {})[seg.name] ?? {}) as BrainSegmentArrangement)
        .transitions as Record<string, { type?: string; placement?: string } | undefined> | undefined;
      if (!brainTransitions) continue;
      for (const tag of Object.keys(brainTransitions).sort()) {
        const entry = brainTransitions[tag];
        if (!entry || entry.type !== 'fxNoiseRise') continue;
        const block = buildNoiseRiseBlock({
          segmentName: seg.name,
          segmentBars: segBars,
          tempo,
          placement: entry.placement ?? 'endOfSegment',
        });
        const segArr = newArrangement[seg.name];
        if (segArr) (segArr.transitions as Record<string, unknown>)[tag] = block;
      }
    }
  }

  // ---- Loop lowering (docs/54r) ----------------------------------------
  // Brain orchestrator (docs/54r) adds a single `InstrumentDefinition`
  // with `type: 'percussionLoops'` plus per-segment
  // `arrangement[seg].instruments[<loopName>] = true/false` flags
  // matching the legacy verse-only activation rule
  // (ArrangementsClass.js:681-708). For each brain-emitted Loop
  // definition we emit one engine inst-N.json (the engine's
  // `Loop.h` ctor reads `details.bpm` + `details.duration`; runtime
  // tiling is in `Loop.h::createSegmentClip` after engine patch 04 —
  // docs/54o). Per-segment `instruments[<loopName>]` is carried
  // verbatim from the brain's flag, defaulting to an explicit `false`
  // when the brain didn't set it (the engine's `isInstrumentInSegment`
  // defaults to true on missing — load-bearing false avoids firing
  // the loop everywhere).
  const loopSummary: Array<{
    name: string;
    catalogId: string | number | undefined;
    durationSeconds: number;
    activeSegments: string[];
  }> = [];
  const loopsDropped: Array<{ name: string; reason: string }> = [];
  const loopDefs = loopDefinitions(song);
  if (loopDefs.length > 0) {
    if (!options.loopSampleProbe) {
      for (const def of loopDefs) {
        loopsDropped.push({
          name: def.name,
          reason: 'no loopSampleProbe supplied (caller must wrap ffprobe for percussionLoops inst lowering)',
        });
      }
    } else {
      const probe = options.loopSampleProbe;
      let nextId = options.loopPlaysampleIdBase ?? 50000;
      // After transitions have appended their inst files, continue from the
      // highest filename index already used (gap-tolerant — see
      // nextInstIndex above). Stable, deterministic.
      let nextFilenameIdx = nextInstIndex();
      for (const def of loopDefs) {
        const probed = probe(def);
        if (
          probed.durationSeconds === null ||
          !Number.isFinite(probed.durationSeconds) ||
          probed.durationSeconds <= 0
        ) {
          loopsDropped.push({
            name: def.name,
            reason: probed.reason ?? `duration probe returned ${probed.durationSeconds}`,
          });
          continue;
        }
        const built = buildLoopInst({
          song,
          playsampleId: nextId++,
          filenameIndex: nextFilenameIdx++,
          def,
          durationSeconds: probed.durationSeconds,
          sourcePath: probed.sourcePath,
        });
        instruments.push({ filename: built.filename, json: built.json });
        // Carry per-segment activation flags from the brain into the
        // engine arrangement. Explicit false on every emitted segment
        // (`isInstrumentInSegment` defaults to true on missing).
        const activeSegments: string[] = [];
        for (const seg of segments) {
          const isActive = segmentHasLoopActive(song, seg.name, built.blockKey);
          const segArr = newArrangement[seg.name];
          if (!segArr) continue;
          (segArr.instruments as Record<string, boolean>)[built.blockKey] = isActive;
          if (isActive) activeSegments.push(seg.name);
        }
        loopSummary.push({
          name: built.blockKey,
          catalogId: def.id,
          durationSeconds: probed.durationSeconds,
          activeSegments,
        });
      }
    }
  }

  // ---- Diagnostics -------------------------------------------------------
  diagnostics.push({
    severity: 'info',
    path: 'structure',
    message:
      `Multi-segment lowering: walked brain's ${segments.length}-segment songStructure ` +
      `(${totalBars} bar(s) total) into the engine structure array. ` +
      `Per-segment activity: ${perSegmentSummary
        .map((s) => `${s.segment}=${s.bars}b[${s.active.join('+') || 'silent'}]`)
        .join(' ')}.`,
    action: 'normalized',
  });
  diagnostics.push({
    severity: 'info',
    path: 'arrangement',
    message:
      'Per-segment arrangement blocks emitted with instruments + overrides. ' +
      'fills now pass through verbatim from brain 53aa (see docs/54o). ' +
      'transitions are resolved when transitionCatalog + duration probe are ' +
      'supplied (see docs/54p); otherwise emitted as empty `{}`. ' +
      'signalProcessors are lowered for supported tags (see docs/54q). ' +
      'mutes / TransitionNoise / TransitionPattern / Vocals remain empty ' +
      '`{}` (deferred — see docs/53z + docs/53k + 54n).',
    action: 'normalized',
  });
  if (signalProcessorsLowered.length > 0 || signalProcessorsDropped.length > 0) {
    const byTag: Record<string, number> = {};
    for (const sp of signalProcessorsLowered) byTag[sp.tag] = (byTag[sp.tag] ?? 0) + 1;
    diagnostics.push({
      severity: 'info',
      path: 'arrangement.signalProcessors',
      message:
        `Lowered ${signalProcessorsLowered.length} signalProcessor block(s) across ` +
        `${new Set(signalProcessorsLowered.map((s) => s.segment)).size} segment(s). ` +
        (signalProcessorsLowered.length > 0
          ? `By tag: ${Object.entries(byTag).map(([k, v]) => `${k}=${v}`).join(' ')}. `
          : '') +
        (signalProcessorsDropped.length > 0
          ? `Dropped ${signalProcessorsDropped.length} (unsupported tag): ${signalProcessorsDropped.map((d) => `${d.segment}/${d.display}=${d.tag}`).join('; ')}.`
          : 'No drops.'),
      action: 'normalized',
    });
  }
  if (!options.transitionCatalog || !options.getTransitionSampleDurationSeconds) {
    // Count the brain-emitted transition tags we would have lowered, so the
    // diagnostic surfaces what was dropped at the boundary.
    let brainTransitionCount = 0;
    for (const seg of segments) {
      const brainAr = ((song.arrangement ?? {})[seg.name] ?? {}) as BrainSegmentArrangement;
      const trans = brainAr.transitions as Record<string, unknown> | undefined;
      if (trans) brainTransitionCount += Object.keys(trans).length;
    }
    if (brainTransitionCount > 0) {
      const missing = !options.transitionCatalog
        ? 'transitionCatalog'
        : 'getTransitionSampleDurationSeconds';
      diagnostics.push({
        severity: 'info',
        path: 'arrangement.transitions',
        message:
          `Brain emitted ${brainTransitionCount} transition tag(s) across ` +
          `${segments.length} segment(s), but no transitionSample inst was ` +
          `lowered because the caller did not supply \`${missing}\`. ` +
          'Engine `transitions: {}` per segment (back-compat). See docs/54p.',
        action: 'dropped',
      });
    }
  }
  if (transitionSummary.length > 0 || transitionsDropped.length > 0) {
    const byTag: Record<string, number> = {};
    const bySource: Record<string, number> = { genre: 0, fallback: 0 };
    for (const t of transitionSummary) {
      byTag[t.tag] = (byTag[t.tag] ?? 0) + 1;
      bySource[t.source]++;
    }
    diagnostics.push({
      severity: 'info',
      path: 'arrangement.transitions',
      message:
        `Lowered ${transitionSummary.length} transitionSample inst(s) across ` +
        `${new Set(transitionSummary.map((t) => t.segment)).size} segment(s). ` +
        `By tag: ${Object.entries(byTag).map(([k, v]) => `${k}=${v}`).join(' ')}. ` +
        `Catalog source: genre=${bySource.genre} fallback=${bySource.fallback}. ` +
        (transitionsDropped.length > 0
          ? `Dropped ${transitionsDropped.length}: ${transitionsDropped.map((d) => `${d.segment}/${d.tag}(${d.reason})`).join('; ')}.`
          : 'No drops.'),
      action: 'normalized',
    });
  }
  diagnostics.push({
    severity: 'info',
    path: 'arrangement.instruments.Vocal',
    message:
      'Vocal family is intentionally not lowered into the engine envelope ' +
      'yet (brain emits a Vocal arrangement entry today but vocal track ' +
      'rendering is deferred — see docs/53z + 53f).',
    action: 'dropped',
  });
  if (loopSummary.length > 0 || loopsDropped.length > 0) {
    diagnostics.push({
      severity: loopsDropped.length > 0 && loopSummary.length === 0 ? 'warning' : 'info',
      path: 'arrangement.loops',
      message:
        `Lowered ${loopSummary.length} percussionLoops inst(s) across ` +
        `${new Set(loopSummary.flatMap((l) => l.activeSegments)).size} active segment(s). ` +
        (loopSummary.length > 0
          ? `By name: ${loopSummary
              .map((l) => `${l.name}(active=${l.activeSegments.length},dur=${l.durationSeconds.toFixed(2)}s)`)
              .join(' ')}. `
          : '') +
        (loopsDropped.length > 0
          ? `Dropped ${loopsDropped.length}: ${loopsDropped.map((d) => `${d.name}(${d.reason})`).join('; ')}.`
          : 'No drops.'),
      action: loopSummary.length > 0 ? 'normalized' : 'dropped',
    });
  }

  // Drums diagnostic: always emitted because inst-1.json is always emitted.
  diagnostics.push({
    severity: 'info',
    path: 'overrides.Drums',
    message:
      `Drums lowering: per-segment kick/snare/hat MIDI events grafted onto ` +
      `each engine segment's overrides.Drums.pattern as 32nd-note ASCII grids. ` +
      `Segments with no kick/snare/hat MIDI events emit instruments.Drums=false ` +
      `(engine isInstrumentInSegment defaults to true on missing entries, so the ` +
      `explicit false is load-bearing).`,
    action: 'normalized',
  });
  diagnostics.push({
    severity: 'info',
    path: 'instrumentDefinitions.Drums',
    message:
      'Drum kit lowering deferred: emitted inst-1.json reuses the Phase 2 ' +
      'known-good 17-id Drums kit (see fixtures/base-drums-inst.json). ' +
      'Catalog-driven drum-kit lowering lands with the catalog snapshot import.',
    action: 'normalized',
  });

  // docs/56b + docs/54w — TonalInstrument patterns[] stub invariant
  // diagnostic. Reports which tonal inst ids had a stub added vs which
  // already had a pre-existing entry in the base envelope. The engine's
  // `TonalInstrument::processSegment` early-returns when
  // `getInstrumentPattern(songData, inst->id)` (SequencerUtils.h:75)
  // finds no entry; without this guard every per-segment override for
  // the unregistered inst is silently dropped.
  if (tonalStubs.length > 0) {
    const addedDescs = tonalStubs
      .filter((s) => s.added)
      .map((s) => `${s.name}(id=${s.id},type=${s.type})`);
    const presentDescs = tonalStubs
      .filter((s) => !s.added)
      .map((s) => `${s.name}(id=${s.id},type=${s.type})`);
    diagnostics.push({
      severity: 'info',
      path: 'patterns.tonalStubs',
      message:
        `TonalInstrument patterns[] stub invariant: every emitted tonal ` +
        `inst (type ∈ {basses, leadSynths, synths, keys, popBrass, ` +
        `popStrings, orchestral, vocals, acousticGuitars, ` +
        `electricGuitars}) has a matching patterns[0].pattern entry so ` +
        `the engine's getInstrumentPattern lookup succeeds and ` +
        `processSegment falls through to the per-segment override ` +
        `(see docs/56b §"Engine patterns[] gap" + docs/54w). ` +
        `Stubs added: ${addedDescs.length === 0 ? '<none>' : addedDescs.join(' ')}. ` +
        `Already present in base envelope: ${presentDescs.length === 0 ? '<none>' : presentDescs.join(' ')}.`,
      action: 'normalized',
    });
  }

  // Per-family tonal diagnostics for the legacy Bass / Keys / Pad lanes —
  // emitted whether or not the family is active so consumers can pin a
  // stable diagnostic shape. (The lane model emits these families through
  // the generic path; the per-family diagnostic is kept for back-compat.)
  emitTonalFamilyDiagnostics({
    family: BASS_DISPLAY_NAME,
    isActive: lanes.some((l) => l.kind === 'bass'),
    song,
    options,
    fileName: 'inst-2.json',
    legacyVstId: 38842,
    legacySampleIdRange: '945..960',
    lowLevelHint:
      'lowLevelType now set from the resolved catalog row (volume + FX routing follow the selection); inst-2.json still reuses the Phase-2 VST wrapper id/structure with the selected sample staged into its 16 slots',
    resolverVerdict: options.bassAssetResolution,
    diagnostics,
  });
  emitTonalFamilyDiagnostics({
    family: KEYS_DISPLAY_NAME,
    isActive: lanes.some((l) => l.kind === 'keys'),
    song,
    options,
    fileName: 'inst-3.json',
    legacyVstId: 38907,
    legacySampleIdRange: '2048..2064',
    lowLevelHint:
      'lowLevelType now set from the resolved catalog row (e.g. keysAcousticPiano) so the engine mixes/routes Keys as keys, not synthsBrightPad; inst-3.json still reuses the Phase-2 Keys VST wrapper id/structure with the selected sample staged into its slots',
    resolverVerdict: options.keysAssetResolution,
    diagnostics,
  });
  emitTonalFamilyDiagnostics({
    family: PAD_DISPLAY_NAME,
    isActive: lanes.some((l) => l.kind === 'pad'),
    song,
    options,
    fileName: 'inst-4.json',
    legacyVstId: 38972,
    legacySampleIdRange: '3153..3169',
    lowLevelHint:
      'lowLevelType now set from the resolved catalog row (e.g. popLowStringsLegato) so the engine mixes/routes Pad as the selected family, not synthsSoftPad; inst-4.json still reuses the Phase-2 Pad VST wrapper id/structure with the selected sample staged into its slots',
    resolverVerdict: options.padAssetResolution,
    diagnostics,
  });

  // Per-lane diagnostics for the parametric tonal lanes (guitar / synths /
  // pluckedSynths / popStrings / popBrass), including duplicate-family lanes
  // (Synths 2, …). Bass/Keys/Pad are covered by the per-family block above.
  for (const lane of lanes) {
    if (FIXTURE_KINDS.has(lane.kind)) continue;
    const activeSegments = Object.entries(newArrangement)
      .filter(([, v]) => v.instruments[lane.name] === true)
      .map(([k]) => k);
    const instJson = instruments.find((f) => f.filename === lane.filename)?.json as
      | { type?: string; lowLevelType?: string; samples?: unknown[] }
      | undefined;
    diagnostics.push({
      severity: 'info',
      path: `arrangement.${lane.name}`,
      message:
        `${lane.name} lane lowered (kind=${lane.kind}): emitted ${lane.filename} ` +
        `(type=${instJson?.type}, lowLevel=${instJson?.lowLevelType}, ` +
        `wrapperId=${lane.vstId}, catalogId=${lane.def?.id ?? '<none>'}). ` +
        `${instJson?.samples?.length ?? 0} multisample slot(s) from id ${lane.sampleBase}. ` +
        `Active on ${activeSegments.length} segment(s): [${activeSegments.join(', ') || '<none>'}]. ` +
        `patterns[0].pattern stub registered by the tonal-stub invariant (see patterns.tonalStubs diagnostic).`,
      action: 'normalized',
    });
  }
  // Discovered-but-inactive parametric lanes: a definition is present but no
  // segment carries an override with events, so no inst-N.json was emitted.
  for (const lane of inactiveLanes) {
    if (FIXTURE_KINDS.has(lane.kind)) continue; // Bass/Keys/Pad → family block
    diagnostics.push({
      severity: 'info',
      path: `arrangement.${lane.name}`,
      message:
        `${lane.name} instrumentDefinition is present (kind=${lane.kind}, ` +
        `id=${lane.def?.id ?? '<none>'}) but no segment carries an override ` +
        `with chord/note events — inst-N.json was not emitted.`,
      action: 'dropped',
    });
  }

  // ---- Volume-table coverage guard ------------------------------------
  // Every emitted `lowLevelType` the engine's `getInstrumentTargetVolume`
  // table does not recognise is silently rendered at unity gain (0 dB)
  // instead of its legacy-ported per-type level — the family-balance bug
  // that hit percussion loops via the catalog's `_<bpm>bpm` suffix. Flag
  // any miss so the next drift surfaces in diagnostics rather than only
  // in the listener's ears. (FX.h:523 → 0 default; Sequencer.cpp:525.)
  for (const miss of collectUnrecognizedLowLevelTypes(instruments)) {
    diagnostics.push({
      severity: 'warning',
      path: `${miss.filename} ${miss.where}`,
      message:
        `lowLevelType "${miss.lowLevelType}" is not in the engine's ` +
        `volume table (FX::getInstrumentTargetVolume) — it will render at ` +
        `the 0 dB unity default instead of a per-type mix level. Check for ` +
        `a taxonomy drift between the catalog and casperaki_engine FX.h.`,
      action: 'kept',
    });
  }

  return {
    songJson: envelope,
    instruments,
    diagnostics,
  };
}

// ---- internals ----

interface BrainNoteEvent {
  type?: string;
  note?: number;
  chord?: string;
  chordType?: string;
  duration?: number;
  // docs/54t — fretNoise event fields. Brain passthrough-only; the
  // adapter copies these arrays unchanged into the engine event.
  sounds?: number[];
  offset?: number[];
  durations?: number[];
  velocities?: number[];
  // docs/54v — virtualGuitarist event fields. Brain passthrough-only;
  // engine resolves the triple against the inst's
  // `virtualGuitaristSamples[]` pool which the adapter pre-builds.
  event?: string;
  chordPosition?: string;
  // docs/54x — per-string strum event fields. Brain passthrough-only.
  // The arrays are parallel and indexed by string position; engine
  // SequencerUtils.h::getStrumNotes consumes them verbatim.
  strings?: number[];
  // docs/54z — EDMArpeggiator event fields. Brain passthrough-only;
  // engine expands the event into per-step TimeNotes via
  // SequencerUtils.h::getEDMArpeggiatorNotes.
  arpeggioType?: string;
  arpeggioRhythm?: string;
  numberOfOctaves?: number;
  noteDuration?: number;
  // docs/55a — noteRelative event field. Brain passthrough-only;
  // engine reads via SequencerUtils.h::getRelativeNote:175-186.
  distanceFromMiddleC?: number;
  // docs/58 — arpeggio event fields. Brain passthrough-only; engine
  // reads via SequencerUtils.h::getArpeggioNotes:160-178.
  octave?: number;
  direction?: string;
  numberOfNotes?: number;
}
interface BrainBar {
  notes?: Record<string, BrainNoteEvent[]>;
  chords?: string[];
}
interface BrainOverride {
  bars?: BrainBar[];
  [key: string]: unknown;
}
interface BrainSegmentArrangement {
  instruments?: Record<string, boolean>;
  overrides?: Record<string, BrainOverride>;
  [key: string]: unknown;
}

function drumBarsHaveAnyHit(bars: BrainBar[]): boolean {
  for (const bar of bars ?? []) {
    for (const events of Object.values(bar.notes ?? {})) {
      for (const ev of events) {
        if (
          ev?.type === 'note' &&
          typeof ev.note === 'number' &&
          Number.isFinite(ev.note)
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

function tonalBarsHaveAnyEvent(bars: BrainBar[]): boolean {
  for (const bar of bars ?? []) {
    for (const events of Object.values(bar.notes ?? {})) {
      for (const ev of events) {
        // docs/54t — fretNoise events also keep the lane active
        // (the engine-side `Guitar.h` fret-noise sampler fires
        // independently from the chord-events branch).
        // docs/54v — virtualGuitarist (strum-sampler) events too.
        // docs/54x — per-string strum events also keep the lane active
        // (route to the same long-notes sampler as chord events but
        // via SequencerUtils.h::getStrumNotes rather than getChordNotes).
        if (
          ev?.type === 'chord' ||
          ev?.type === 'note' ||
          ev?.type === 'fretNoise' ||
          ev?.type === 'virtualGuitarist' ||
          ev?.type === 'strum' ||
          ev?.type === 'EDMArpeggiator' ||
          ev?.type === 'arpeggio' ||
          ev?.type === 'noteRelative'
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

interface TonalFamilyDiagnosticArgs {
  family: string;
  isActive: boolean;
  song: Song;
  options: ToEngineFixtureOptions;
  fileName: string;
  legacyVstId: number;
  legacySampleIdRange: string;
  lowLevelHint: string;
  resolverVerdict?: AssetResolutionInfo;
  diagnostics: AdapterDiagnostic[];
}

function emitTonalFamilyDiagnostics(args: TonalFamilyDiagnosticArgs): void {
  const { family, isActive, song, fileName, diagnostics } = args;
  if (!isActive) {
    diagnostics.push({
      severity: 'info',
      path: `overrides.${family}`,
      message:
        `${family} lowering skipped: no brain segment carries a ${family} override ` +
        `with chord/note events. Output is ${family}-free and ${fileName} is not emitted.`,
      action: 'dropped',
    });
    return;
  }
  diagnostics.push({
    severity: 'info',
    path: `overrides.${family}`,
    message:
      family === BASS_DISPLAY_NAME
        ? `Bass lowering: per-segment brain MIDI bass events lowered to type=noteAbsolute ` +
          `(engine cancels chord transposition for noteAbsolute → exact pitch passes through). ` +
          `bars[].notes keys preserved verbatim from brain BarBeat strings.`
        : `${family} lowering: per-segment brain chord/note events lowered to engine chord/noteAbsolute shape. ` +
          `Chord events carry a default chordType voicing (engine getChordNotes() throws on missing voicing).`,
    action: 'normalized',
  });

  const def = (song.instrumentDefinitions ?? []).find((d) => d?.name === family);
  diagnostics.push({
    severity: 'info',
    path: `instrumentDefinitions.${family}`,
    message:
      `${family} instrument lowering deferred: emitted ${fileName} reuses the ` +
      `Phase 2 / legacy ${family} VST kit (id=${args.legacyVstId}, samples ` +
      `${args.legacySampleIdRange}) — ${args.lowLevelHint}. Brain-selected ` +
      `${family} entry: ${
        def ? `id=${def.id} lowLevel=${def.lowLevelType}` : '<absent>'
      }. Catalog-driven ${family} kit lowering lands with the per-family VST-sample ` +
      `bridge work (53k engine-bridge inventory).`,
    action: 'normalized',
  });

  if (args.resolverVerdict) {
    const r = args.resolverVerdict;
    const summary =
      r.status === 'resolved'
        ? `resolved (${r.matchKind ?? 'unknown'}): ${r.relativePath ?? '<no path>'}`
        : `unresolved: ${r.reason ?? '<no reason>'}`;
    diagnostics.push({
      severity: r.status === 'resolved' ? 'info' : 'warning',
      path: `assetResolver.${family}`,
      message:
        `Asset resolver verdict for brain-selected ${family} entry` +
        (r.entryId ? ` (${r.entryId})` : '') +
        `: ${summary}. The verdict is informational; the bundled ${fileName} ` +
        `sample ids drive the engine sampler today (see ${family} ` +
        `instrumentDefinitions diagnostic above).`,
      action: 'kept',
    });
  } else {
    diagnostics.push({
      severity: 'info',
      path: `assetResolver.${family}`,
      message:
        `Asset resolver verdict not supplied via options.${family.toLowerCase()}AssetResolution; ` +
        `the CLI / brain harness can wire \`resolveAssetPath(${family.toLowerCase()}Entry, { key, bpm })\` ` +
        `and pass the result through. Informational only — the bundled ${fileName} drives ` +
        `the sampler regardless.`,
      action: 'kept',
    });
  }
}

/**
 * Lower brain Keys/Pad bars into engine tonal bars:
 * - `type: 'chord'` → engine `type: 'chord'` with `chord`, `duration`, and
 *   the supplied default `chordType` voicing the engine needs.
 * - `type: 'note'` (MIDI int, pad single-note style) → engine
 *   `type: 'noteAbsolute'` (note-name string) so chord transposition is
 *   cancelled and the brain's already-resolved pitch passes through to
 *   the sampler verbatim — same mechanism as Bass (see docs/53w).
 */
function tonalBarsFromBrainBars(
  brainBars: BrainBar[],
  defaultChordType: string,
): EngineTonalBar[] {
  return brainBars.map((bar) => {
    const notes: Record<string, EngineTonalEvent[]> = {};
    const beatKeys = Object.keys(bar.notes ?? {}).sort(
      (a, b) => Number.parseFloat(a) - Number.parseFloat(b),
    );
    for (const beatKey of beatKeys) {
      const events = bar.notes?.[beatKey] ?? [];
      const out: EngineTonalEvent[] = [];
      for (const ev of events) {
        const duration =
          typeof ev?.duration === 'number' && Number.isFinite(ev.duration)
            ? ev.duration
            : 1;
        if (ev?.type === 'chord' && typeof ev.chord === 'string') {
          out.push({
            type: 'chord',
            chord: ev.chord,
            chordType:
              typeof ev.chordType === 'string' ? ev.chordType : defaultChordType,
            duration,
          });
        } else if (
          ev?.type === 'note' &&
          typeof ev.note === 'number' &&
          Number.isFinite(ev.note)
        ) {
          out.push({
            type: 'noteAbsolute',
            note: midiToEngineNoteName(ev.note),
            duration,
          });
        } else if (
          ev?.type === 'fretNoise' &&
          Array.isArray(ev.sounds) &&
          Array.isArray(ev.offset) &&
          Array.isArray(ev.durations) &&
          Array.isArray(ev.velocities)
        ) {
          // docs/54t — passthrough. Adapter normalises the array
          // entries to numbers (legacy emitted ints; we accept
          // numbers and trust the upstream schema gate already
          // validated them as nonNeg / numeric).
          out.push({
            type: 'fretNoise',
            sounds: ev.sounds.slice() as number[],
            offset: ev.offset.slice() as number[],
            durations: ev.durations.slice() as number[],
            velocities: ev.velocities.slice() as number[],
          });
        } else if (
          ev?.type === 'virtualGuitarist' &&
          typeof ev.event === 'string'
        ) {
          // docs/54v — passthrough. Engine reads `event`, `duration`,
          // and (optionally) `chordPosition` / `chord`. Default
          // duration to 0.25 (engine's smallest legitimate strum
          // window) if brain didn't set one — keeps the engine's
          // negative-duration short-circuit at bay (docs/54m §"Bug
          // 2 — getGuitarStrums rejects integer JSON durations").
          out.push({
            type: 'virtualGuitarist',
            event: ev.event,
            duration: duration === 1 && typeof ev?.duration !== 'number' ? 0.25 : duration,
            ...(typeof ev.chord === 'string' ? { chord: ev.chord } : {}),
            ...(typeof ev.chordPosition === 'string'
              ? { chordPosition: ev.chordPosition }
              : {}),
          });
        } else if (
          ev?.type === 'strum' &&
          typeof ev.chord === 'string' &&
          Array.isArray(ev.strings) &&
          Array.isArray(ev.offset) &&
          Array.isArray(ev.durations) &&
          Array.isArray(ev.velocities)
        ) {
          // docs/54x — per-string strum passthrough. The brain emits
          // events from the legacy guitarPatterns.json bank (chord =
          // "C" literal from the bank; the brain rewrites it to the
          // segment's chord before emission so the field is meaningful
          // for diagnostics — the engine itself uses `currentChord`
          // not `noteData["chord"]` for the MIDI lookup, see
          // SequencerUtils.h::getStrumNotes:216).
          out.push({
            type: 'strum',
            chord: ev.chord,
            strings: ev.strings.slice() as number[],
            offset: ev.offset.slice() as number[],
            durations: ev.durations.slice() as number[],
            velocities: ev.velocities.slice() as number[],
          });
        } else if (
          ev?.type === 'EDMArpeggiator' &&
          typeof ev.chord === 'string' &&
          typeof ev.arpeggioType === 'string' &&
          typeof ev.arpeggioRhythm === 'string' &&
          typeof ev.numberOfOctaves === 'number'
        ) {
          // docs/54z — EDMArpeggiator passthrough. Engine reads chord,
          // arpeggioType, arpeggioRhythm, numberOfOctaves, duration,
          // noteDuration; the engine expands per-step notes itself via
          // SequencerUtils.h::getEDMArpeggiatorNotes (333+).
          out.push({
            type: 'EDMArpeggiator',
            chord: ev.chord,
            arpeggioType: ev.arpeggioType,
            arpeggioRhythm: ev.arpeggioRhythm,
            numberOfOctaves: ev.numberOfOctaves,
            duration: typeof ev.duration === 'number' ? ev.duration : 0.25,
            noteDuration:
              typeof ev.noteDuration === 'number' ? ev.noteDuration : 0.25,
          });
        } else if (
          ev?.type === 'arpeggio' &&
          typeof ev.chord === 'string' &&
          typeof ev.octave === 'number' &&
          typeof ev.direction === 'string' &&
          typeof ev.numberOfNotes === 'number' &&
          typeof ev.note === 'number'
        ) {
          // docs/58 — arpeggio passthrough. Engine reads octave,
          // direction, numberOfNotes, note, duration and walks the
          // current chord itself (SequencerUtils.h::getArpeggioNotes).
          // `chord` is informational.
          out.push({
            type: 'arpeggio',
            chord: ev.chord,
            octave: ev.octave,
            direction: ev.direction,
            numberOfNotes: ev.numberOfNotes,
            note: ev.note,
            duration,
          });
        } else if (
          ev?.type === 'noteRelative' &&
          typeof ev.chord === 'string' &&
          typeof ev.distanceFromMiddleC === 'number'
        ) {
          // docs/55a — noteRelative passthrough. Engine
          // SequencerUtils.h::getRelativeNote:175-186 reads
          // distanceFromMiddleC + duration, snaps to currentChord's
          // nearest note. `chord` is informational.
          out.push({
            type: 'noteRelative',
            chord: ev.chord,
            distanceFromMiddleC: ev.distanceFromMiddleC,
            duration: typeof ev.duration === 'number' ? ev.duration : 1,
          });
        }
      }
      if (out.length > 0) notes[beatKey] = out;
    }
    return { notes };
  });
}

/**
 * Build a 32-step 32nd-note ASCII grid for `midi`, scanning brain drum bars
 * for the first bar that contains an event at that MIDI value. The brain
 * emits a single-bar repeating pattern per segment today; the engine repeats
 * the grid across the segment's bar count.
 */
function gridFromBrainBars(drumBars: BrainBar[], midi: number): string {
  for (const bar of drumBars) {
    const grid = new Array(32).fill('0');
    let hit = false;
    for (const [beatKey, events] of Object.entries(bar.notes ?? {})) {
      const beat = Number.parseFloat(beatKey);
      if (!Number.isFinite(beat)) continue;
      for (const ev of events) {
        if (ev?.type === 'note' && ev.note === midi) {
          const idx = Math.round(beat * 8);
          if (idx >= 0 && idx < 32) {
            grid[idx] = 'x';
            hit = true;
          }
        }
      }
    }
    if (hit) return grid.join('');
  }
  return new Array(32).fill('0').join('');
}

const NOTE_NAMES = [
  'c',
  'c#',
  'd',
  'd#',
  'e',
  'f',
  'f#',
  'g',
  'g#',
  'a',
  'a#',
  'b',
] as const;

/**
 * Convert a MIDI integer to the lowercase note-name + octave string the
 * legacy engine consumes (e.g. MIDI 36 → "c2"; MIDI 46 → "a#2"). Mirrors
 * the inverse of `getMidiNoteNumber` in casperaki_engine/Source/music/Note.h
 * (octave 0 starts at MIDI 12).
 */
export function midiToEngineNoteName(midi: number): string {
  if (!Number.isFinite(midi) || midi < 0 || midi > 127) {
    throw new RangeError(`midiToEngineNoteName: out-of-range MIDI ${midi}`);
  }
  const m = Math.round(midi);
  const octave = Math.floor(m / 12) - 1;
  const idx = ((m % 12) + 12) % 12;
  return `${NOTE_NAMES[idx]}${octave}`;
}

/**
 * Lower brain bass bars (`type: 'note'`, MIDI int pitch, BarBeat string
 * keys) into the engine's `noteAbsolute`-typed bar shape (note-name
 * strings, BarBeat keys preserved). The engine's `getSimpleNote` cancels
 * chord transposition for `noteAbsolute` events (delta = 0 against a `C`
 * chord), so the brain's already-resolved chord-relative pitch passes
 * through to the sampler verbatim.
 */
function bassBarsFromBrainBars(brainBars: BrainBar[]): EngineBassBar[] {
  return brainBars.map((bar) => {
    const notes: Record<string, EngineBassNote[]> = {};
    const beatKeys = Object.keys(bar.notes ?? {}).sort(
      (a, b) => Number.parseFloat(a) - Number.parseFloat(b),
    );
    for (const beatKey of beatKeys) {
      const events = bar.notes?.[beatKey] ?? [];
      const out: EngineBassNote[] = [];
      for (const ev of events) {
        if (ev?.type !== 'note') continue;
        if (typeof ev.note !== 'number' || !Number.isFinite(ev.note)) continue;
        const duration = typeof ev.duration === 'number' ? ev.duration : 0.25;
        out.push({
          type: 'noteAbsolute',
          note: midiToEngineNoteName(ev.note),
          duration,
        });
      }
      if (out.length > 0) notes[beatKey] = out;
    }
    return { notes };
  });
}
