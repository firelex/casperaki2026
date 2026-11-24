// Step 8 — orchestrator.
//
// Runs the structure → chords → selection → patterns → vocals pipeline
// with a single seeded ctx, then lowers the five brain-internal results
// into a canonical `@casperaki/song-schema` Song envelope.
//
// THE LOWERING IS A SLICE BRIDGE. Most of the intermediate values come
// from hand-authored vertical-slice fixtures (one precedent, one
// catalog row per family, one lyric phrase). They are placeholders for
// the legacy generators / data they will be replaced by — the
// docs/53g writeup carries the legacy-provenance table.
//
// Public surface:
//   - orchestrate(params): runs the full pipeline and returns a Song.
//   - lowerToSong(...): the pure projection step; testable in isolation
//     so we can assert non-mutation of intermediates explicitly.

import { createRng } from '@casperaki/music-theory';
import {
  parseSong,
  type FillBlock,
  type InstrumentDefinition,
  type MuteEntry,
  type Segment,
  type SegmentPayload,
  type SignalProcessorBlock,
  type Song,
  type SongStructure,
  type TransitionEntry,
} from '@casperaki/song-schema';

import type { GenerateParams } from '../context.js';
import {
  generateFills,
  generateMutes,
  generateSignalProcessors,
  generateTransitions,
  type ArrangementFills,
  type ArrangementMutes,
  type ArrangementSignalProcessors,
  type ArrangementTransitions,
} from '../arrangement-polish/index.js';
import { resolveArrangementClashes } from '../arrangement-polish/clashes.js';
import { applyArrangementOverrides, decideDrumOverrides } from '../arrangement-polish/overrides.js';
import { generateChords } from '../chords/index.js';
import { generatePatterns } from '../patterns/index.js';
import { selectInstruments } from '../selection/index.js';
import { generateSongStructure } from '../structure/index.js';
import { writeVocals } from '../vocals/index.js';
import { applyTrackEditsToSelection, recordedDrumSounds, recordedTrackEdits } from '../edits/recorded.js';
import { drumKit, DRUM_SOUNDS_DETAIL } from '../drums/kit.js';

import type { ValidatedCatalogEntry } from '../catalog/validated-catalog.js';
import { LOOP_DISPLAY_NAME } from '../selection/index.js';
import type { InstrumentFamily, SelectionResult } from '../selection/types.js';
import type { FamilyPattern, PatternResult } from '../patterns/types.js';
import type { VocalBar, VocalResult } from '../vocals/types.js';

// Display names match the legacy engine's per-segment instrument keys.
const DISPLAY_NAME_FOR_ROLE: Readonly<Record<InstrumentFamily, string>> = {
  drums: 'Drums',
  bass: 'Bass',
  keys: 'Keys',
  pad: 'Pad',
  guitar: 'Guitar',
  // docs/54z — engine `Instrument::Type::leadSynths` maps to the
  // same Synths.h class as keys/popStrings/popBrass/orchestral
  // (CasperakiEngine.cpp:445-453). Display name mirrors the engine's
  // per-segment key convention.
  synths: 'Synths',
  // docs/55a — synths/synthsPlucked routes via `Instrument.cpp:118`
  // (`"synths"` → `Type::synths` → `Synths.h`). Separate brain
  // display name from the leadSynths "Synths" lane so segment
  // overrides + inst-N.json files stay distinct.
  pluckedSynths: 'PluckedSynths',
  // docs/58 — orchestral pop strings + brass. Both route through Synths.h
  // (Instrument.cpp getType: "popStrings"/"popBrass" → Type → Synths.h;
  // CasperakiEngine.cpp:445-453). Like PluckedSynths, these are NOT in the
  // universal display-name set — they are conditionally added per-segment
  // only when the brain selects the role (edm/schlager strings, schlager
  // brass), so other genres don't sprout `false` flags.
  popStrings: 'PopStrings',
  popBrass: 'PopBrass',
};
const VOCAL_DISPLAY_NAME = 'Vocal';
// Legacy display names for the backing vocal lanes (Step 17d; see
// docs/53ah). Surfaced ONLY on segments that carry backing data — keeping
// them off ALL_DISPLAY_NAMES means non-backing segments don't sprout
// `false` flags they would never have carried in the legacy engine.
const BACKING_1_DISPLAY_NAME = 'Backing vocals 1';
const BACKING_2_DISPLAY_NAME = 'Backing vocals 2';

// Every segment's `instruments` map declares all display names so
// downstream (engine, replay) can rely on the key set without probing.
// Inactive families are `false`; tests pin this choice explicitly.
// Step 17d adds `Backing vocals 1/2` to the universal set; segments
// where the backing activity gate did not fire carry `false`, matching
// the legacy `_createMelodyTemplate` behaviour (MelodyClass.js:296-309).
// docs/55a — `PluckedSynths` is NOT in the universal display name
// set. The brightPop seed has zero `synths/synthsPlucked` catalog
// candidates (catalog rows are all `mainStyle:'edm'`), so the brain
// does not pick a PluckedSynths InstrumentDefinition for brightPop.
// When a future seed picks one, the orchestrator adds the
// `PluckedSynths` key to per-segment instruments maps conditionally
// — same pattern the percussion-loop lane uses (docs/54r).
const ALL_DISPLAY_NAMES: readonly string[] = [
  DISPLAY_NAME_FOR_ROLE.drums,
  DISPLAY_NAME_FOR_ROLE.bass,
  DISPLAY_NAME_FOR_ROLE.keys,
  DISPLAY_NAME_FOR_ROLE.pad,
  DISPLAY_NAME_FOR_ROLE.guitar,
  DISPLAY_NAME_FOR_ROLE.synths,
  VOCAL_DISPLAY_NAME,
  BACKING_1_DISPLAY_NAME,
  BACKING_2_DISPLAY_NAME,
];

// Fixture vocal instrument — real vocal selection arrives with the
// catalog-indexing task that replaces the slice's hand-authored
// catalog.json (see docs/53d-step5-selection.md).
const VOCAL_INSTRUMENT_FIXTURE: InstrumentDefinition = {
  id: 'dev-vocal-pop-01',
  name: VOCAL_DISPLAY_NAME,
  shortName: 'Slice Placeholder Vocalist',
  type: 'VocaloidPlaceholder',
  lowLevelType: 'Vocal',
  instrumentGroup: 'Vocal',
};
// Step 17d — placeholder definitions for the two backing lanes. Same
// VocaloidPlaceholder shape as the lead; real selection arrives with
// the deferred vocal catalog-indexing task.
const BACKING_1_INSTRUMENT_FIXTURE: InstrumentDefinition = {
  id: 'dev-vocal-backing-1',
  name: BACKING_1_DISPLAY_NAME,
  shortName: 'Slice Placeholder Backing 1',
  type: 'VocaloidPlaceholder',
  lowLevelType: 'Vocal',
  instrumentGroup: 'Vocal',
};
const BACKING_2_INSTRUMENT_FIXTURE: InstrumentDefinition = {
  id: 'dev-vocal-backing-2',
  name: BACKING_2_DISPLAY_NAME,
  shortName: 'Slice Placeholder Backing 2',
  type: 'VocaloidPlaceholder',
  lowLevelType: 'Vocal',
  instrumentGroup: 'Vocal',
};

export const ORCHESTRATOR_NAME = '@casperaki/arrangement.orchestrate';
export const ORCHESTRATOR_VERSION = '0.1.0';

export function orchestrate(params: GenerateParams): Song {
  const ctx = { params, rng: createRng(params.seed) };
  const structure = generateSongStructure(ctx);
  // The vocals come first: sung sections take the chords of the melody they
  // borrow (in the song's key), and every other part is written over those.
  const { vocals, structure: structureWithChords } = writeVocals(ctx, generateChords(ctx, structure));
  // Sequencer track edits (generator params `trackEdits`): applied to the
  // selection, so each edit only touches its own lane's streams.
  const baseSelection = selectInstruments(ctx, structureWithChords);
  const trackEdits = recordedTrackEdits(params.params);
  const edited = applyTrackEditsToSelection(baseSelection, trackEdits, params.genre);
  const selection = edited.selection;
  // to-do #1 Phase B — bake the per-segment drum + bass override system into
  // the freshly-generated patterns (the engine reset path bypasses its own
  // mask branch, so masks bake into the emitted pattern). Forks the root rng,
  // so only the Drums / Bass override bars change.
  // docs/62 B13 — the per-segment Drums override gates the EDM fill/buildup
  // transition. Compute the decisions ONCE (fork is name-keyed + order-
  // independent, so this is identical to applyArrangementOverrides' own fork)
  // and thread them into both the override baker and the transition generator.
  const drumDecisions = decideDrumOverrides(
    ctx.rng.fork('arrangement-polish/drum-overrides'),
    structureWithChords,
    ctx.params.genre,
  );
  const written = (sel: typeof selection, variants: Map<string, number>) =>
    applyArrangementOverrides(ctx, structureWithChords, sel, generatePatterns(ctx, structureWithChords, sel, variants), drumDecisions);
  // Parts that get in each other's way are adjusted after they are written (arrangement-polish/clashes.ts): a
  // second busy part calms down, a part in rhythmic unison with another in its register is moulded around it.
  // Track edits only ever change their own track (they are spliced into the song as it was): clashes are resolved on
  // the song as generated without the edits, and the edited tracks are then laid in as written. Every lane forks its
  // own rng, so writing the patterns twice draws the same notes.
  const editedTracks = new Set(trackEdits.flatMap((e) => ('track' in e ? [e.track] : [])));
  const patterns =
    editedTracks.size === 0
      ? resolveArrangementClashes(written(selection, edited.laneVariants))
      : withEditedTracks(resolveArrangementClashes(written(baseSelection, new Map())), written(selection, edited.laneVariants), editedTracks);
  const fills = generateFills(ctx, structureWithChords, selection);
  const mutes = generateMutes(ctx, structureWithChords, selection);
  const transitions = generateTransitions(ctx, structureWithChords, drumDecisions);
  const signalProcessors = generateSignalProcessors(ctx, structureWithChords, selection);
  return lowerToSong({
    params,
    structure: structureWithChords,
    selection,
    patterns,
    vocals,
    fills,
    mutes,
    transitions,
    signalProcessors,
  });
}

/** The song's patterns: the edited tracks as written with their edits, every other lane as resolved without them. */
function withEditedTracks(resolved: PatternResult, writtenWithEdits: PatternResult, editedTracks: ReadonlySet<string>): PatternResult {
  const resolvedBySegment = new Map(resolved.segments.map((s) => [s.segmentName, s.lanes]));
  return {
    segments: writtenWithEdits.segments.map((seg) => {
      const base = resolvedBySegment.get(seg.segmentName);
      const lanes = Object.fromEntries(
        Object.entries(seg.lanes).map(([lane, p]) => [lane, editedTracks.has(lane) || !base?.[lane] ? p : base[lane]!]),
      );
      return { ...seg, lanes };
    }),
  };
}

export interface LowerInputs {
  readonly params: GenerateParams;
  readonly structure: SongStructure;
  readonly selection: SelectionResult;
  readonly patterns: PatternResult;
  readonly vocals: VocalResult;
  readonly fills?: ArrangementFills;
  readonly mutes?: ArrangementMutes;
  readonly transitions?: ArrangementTransitions;
  readonly signalProcessors?: ArrangementSignalProcessors;
}

export function lowerToSong(inputs: LowerInputs): Song {
  const {
    params,
    structure,
    selection,
    patterns,
    vocals,
    fills,
    mutes,
    transitions,
    signalProcessors,
  } = inputs;

  const arrangement: Record<string, SegmentPayload> = {};
  const vocalSegmentsByName = new Map(vocals.segments.map((s) => [s.segmentName, s]));
  const backing1ByName = new Map((vocals.backings ?? []).map((s) => [s.segmentName, s]));
  const backing2ByName = new Map((vocals.backings2 ?? []).map((s) => [s.segmentName, s]));
  const patternSegmentsByName = new Map(patterns.segments.map((s) => [s.segmentName, s]));
  const activityByName = new Map(
    selection.segments.map((s) => [s.segmentName, s.activeLanes]),
  );
  const loopActiveByName = new Map(
    selection.segments.map((s) => [s.segmentName, s.loopActive]),
  );

  // docs/58i — ordered list of the LANES the brain selected (roster order).
  // The per-segment instruments map declares exactly these (true/false) so it
  // stays aligned with instrumentDefinitions (the semantic validator pins
  // every per-segment instruments key to an instrumentDefinition name).
  const orderedLanes = selection.instruments.map((s) => s.lane);

  for (const segment of structure) {
    const activeLanes = activityByName.get(segment.name) ?? [];
    const patternSegment = patternSegmentsByName.get(segment.name);
    const vocalSegment = vocalSegmentsByName.get(segment.name);
    const backing1 = backing1ByName.get(segment.name);
    const backing2 = backing2ByName.get(segment.name);
    arrangement[segment.name] = buildSegmentPayload(
      segment,
      activeLanes,
      patternSegment?.lanes,
      vocalSegment?.bars,
      backing1?.bars,
      backing2?.bars,
      fills?.bySegment[segment.name],
      mutes?.bySegment[segment.name],
      transitions?.bySegment[segment.name],
      signalProcessors?.bySegment[segment.name],
      selection.loop ? loopActiveByName.get(segment.name) ?? false : undefined,
      selection.loop?.displayName,
      orderedLanes,
    );
  }

  const instrumentDefinitions = withDrumSounds(
    buildInstrumentDefinitions(selection, vocals),
    recordedDrumSounds(recordedTrackEdits(params.params)),
    params.genre,
  );

  const raw = {
    schemaVersion: '1' as const,
    key: params.key,
    bpm: params.bpm,
    genre: params.genre,
    songStructure: structure,
    arrangement,
    instrumentDefinitions,
    aiArtifacts: [],
    generator: {
      name: ORCHESTRATOR_NAME,
      version: ORCHESTRATOR_VERSION,
      seed: params.seed,
      params: {
        genre: params.genre,
        key: params.key,
        bpm: params.bpm,
        ...(params.params && { params: params.params }),
      },
    },
  };

  // parseSong does Zod + semantic validation, so the orchestrator's
  // return value is always schema-valid by construction.
  return parseSong(raw);
}

function buildSegmentPayload(
  segment: Segment,
  activeLanes: readonly string[],
  lanePatterns: PatternResult['segments'][number]['lanes'] | undefined,
  vocalBars: readonly VocalBar[] | undefined,
  backing1Bars: readonly VocalBar[] | undefined,
  backing2Bars: readonly VocalBar[] | undefined,
  fillsForSegment: Readonly<Record<string, FillBlock>> | undefined,
  mutesForSegment: Readonly<Record<string, MuteEntry>> | undefined,
  transitionsForSegment: Readonly<Record<string, TransitionEntry>> | undefined,
  signalProcessorsForSegment: Readonly<Record<string, SignalProcessorBlock>> | undefined,
  loopActive: boolean | undefined,
  loopDisplayName: string | undefined,
  orderedLanes: readonly string[],
): SegmentPayload {
  const activeSet = new Set(activeLanes);
  const instruments: Record<string, boolean> = {};
  // docs/58i — declare every roster lane (in roster order), true when active
  // this segment. Keeps the per-segment instruments map aligned with
  // instrumentDefinitions (the semantic validator pins every key to a def).
  for (const lane of orderedLanes) {
    instruments[lane] = activeSet.has(lane);
  }
  instruments[VOCAL_DISPLAY_NAME] = vocalBars !== undefined;
  // Backing lanes (Step 17d): declare them on EVERY segment so the
  // canonical Song carries the same key set everywhere. False where the
  // activity gate did not fire (verse / preChorus / intro / outro /
  // break), true on chorus + bridge where the lead is present.
  instruments[BACKING_1_DISPLAY_NAME] = backing1Bars !== undefined;
  instruments[BACKING_2_DISPLAY_NAME] = backing2Bars !== undefined;
  // Loop lane (docs/54r). Declare on every segment when the selection
  // chose a loop, so the engine's `isInstrumentInSegment` (defaults true
  // on missing) sees an explicit false on non-active segments. Omit the
  // key entirely when no loop was chosen — keeps the canonical Song
  // shape unchanged for non-percussion genres.
  if (loopDisplayName && loopActive !== undefined) {
    instruments[loopDisplayName] = loopActive;
  }

  // Overrides flow through parseSong (= Zod + semantic) at the end, so we
  // pass them as opaque-typed records here and let the schema brand
  // BarBeat / ChordSymbol / NoteRef on the way in.
  const overrides: Record<string, unknown> = {};
  if (lanePatterns) {
    // lanePatterns is already keyed by lane display name (docs/58i).
    for (const [lane, fam] of Object.entries(lanePatterns)) {
      const pat: FamilyPattern | undefined = fam;
      if (!pat) continue;
      overrides[lane] = {
        bars: pat.bars.map((bar) => ({ notes: { ...bar.notes } })),
      };
    }
  }
  if (vocalBars) {
    overrides[VOCAL_DISPLAY_NAME] = {
      bars: vocalBars.map((bar) => ({ notes: { ...bar.notes } })),
    };
  }
  if (backing1Bars) {
    overrides[BACKING_1_DISPLAY_NAME] = {
      bars: backing1Bars.map((bar) => ({ notes: { ...bar.notes } })),
    };
  }
  if (backing2Bars) {
    overrides[BACKING_2_DISPLAY_NAME] = {
      bars: backing2Bars.map((bar) => ({ notes: { ...bar.notes } })),
    };
  }

  // Side-blocks default to `{}` per SegmentPayloadSchema. We pass any
  // legacy-derived entries through verbatim; absent generators leave the
  // block empty.
  return {
    instruments,
    overrides,
    fills: (fillsForSegment ?? {}) as Record<string, FillBlock>,
    mutes: (mutesForSegment ?? {}) as Record<string, MuteEntry>,
    signalProcessors: (signalProcessorsForSegment ?? {}) as Record<string, SignalProcessorBlock>,
    transitions: (transitionsForSegment ?? {}) as Record<string, TransitionEntry>,
  } as SegmentPayload;
}

/** The user's drum sounds (recorded setDrumSound edits) on the Drums definition. */
function withDrumSounds(defs: InstrumentDefinition[], sounds: Record<string, string>, genre: string): InstrumentDefinition[] {
  if (Object.keys(sounds).length === 0) return defs;
  drumKit(genre, sounds); // validates every role and sound
  if (!defs.some((d) => d.name === 'Drums')) throw new Error('orchestrate: drum sounds are recorded but the song has no Drums track');
  return defs.map((d) => (d.name === 'Drums' ? { ...d, details: { ...(d.details ?? {}), [DRUM_SOUNDS_DETAIL]: { ...sounds } } } : d));
}

function buildInstrumentDefinitions(
  selection: SelectionResult,
  vocals: VocalResult,
): InstrumentDefinition[] {
  const definitions: InstrumentDefinition[] = selection.instruments.map((lane) =>
    instrumentDefinitionFromCatalog(lane.lane, lane.entry),
  );
  if (vocals.segments.length > 0) {
    definitions.push({ ...VOCAL_INSTRUMENT_FIXTURE });
  }
  if ((vocals.backings ?? []).length > 0) {
    definitions.push({ ...BACKING_1_INSTRUMENT_FIXTURE });
  }
  if ((vocals.backings2 ?? []).length > 0) {
    definitions.push({ ...BACKING_2_INSTRUMENT_FIXTURE });
  }
  if (selection.loop) {
    definitions.push(loopInstrumentDefinition(selection.loop));
  }
  return definitions;
}

/** Build a canonical InstrumentDefinition for the percussion-loop pick.
 *  Carries the catalog row id, the lowLevel (preserving the bpm-band
 *  suffix from the audit — e.g. `percussionLoopsAcoustic_90-119bpm`),
 *  and the song's bpm under `details.bpm`. `details.duration` is
 *  intentionally absent here — the brain has no FS / ffprobe access;
 *  the engine adapter (or its CLI) probes the staged sample and adds
 *  it before the engine consumes the inst-N.json. (docs/54r) */
function loopInstrumentDefinition(loop: SelectionResult['loop']): InstrumentDefinition {
  if (!loop) throw new Error('loopInstrumentDefinition: called without loop');
  const e = loop.entry;
  const shortName =
    e.library && e.preset
      ? `${e.library} - ${e.preset}`
      : e.preset ?? e.library ?? e.lowLevel;
  return {
    id: e.id,
    name: loop.displayName,
    shortName,
    type: 'percussionLoops',
    lowLevelType: e.lowLevel,
    instrumentGroup: 'percussion',
    isSample: true,
    isVst: false,
    details: { bpm: e.bpm ?? null },
  } as InstrumentDefinition;
}

export function instrumentDefinitionFromCatalog(
  lane: string,
  entry: ValidatedCatalogEntry,
): InstrumentDefinition {
  // shortName combines library + preset when both are present so the
  // engine display + debug logs identify the exact catalog row; the raw
  // catalog id stays the canonical identifier (`id`). The lane display name
  // (docs/58i) is the engine routing key — `Drums`/`Bass`/…/`Guitar 2`.
  const shortName =
    entry.library && entry.preset
      ? `${entry.library} - ${entry.preset}`
      : entry.preset ?? entry.library ?? entry.lowLevel;
  return {
    id: entry.id,
    name: lane,
    shortName,
    type: entry.lowLevel,
    lowLevelType: entry.lowLevel,
    instrumentGroup: entry.family,
  };
}

export const DISPLAY_NAMES = ALL_DISPLAY_NAMES;
