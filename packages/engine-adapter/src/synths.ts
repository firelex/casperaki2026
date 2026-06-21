// docs/54z — Synths (leadSynths) inst-N.json builder.
//
// Engine: `CasperakiEngine.cpp:445-453` maps both `leadSynths` and
// `synths` types to the same `Synths.h` class (same as keys / popBrass /
// popStrings / orchestral / vocals). The inst-N.json shape mirrors
// Bass/Keys/Pad: a `samples[]` array of `{id, note, type:'longNote',
// vst}` slots at the chromatic positions the family's slicing JSON
// defines.
//
// The 17-note grid matches `data/vst-slice-timings/padAndSynthNotes.json`
// (c2, d#2, f#2, a2, …, c6) — the same grid Keys/Pad already use today
// (54l). The id range starts at 4000, clear of every other allocated
// pool (Drums 100/26929+, Bass 945+, Keys 2048+, Pad 3153+, Guitar
// 9000+, transitions 40000+, loops 50000+). The vst id 39140 stays
// clear of the other tonal wrappers (Bass 38842, Keys 38907, Pad 38972,
// Guitar 39111) and the transition id base.

import type { InstrumentDefinition } from '@casperaki/song-schema';

const SYNTHS_NOTE_GRID: readonly string[] = [
  'c2', 'd#2', 'f#2', 'a2',
  'c3', 'd#3', 'f#3', 'a3',
  'c4', 'd#4', 'f#4', 'a4',
  'c5', 'd#5', 'f#5', 'a5',
  'c6',
];

export const SYNTHS_DISPLAY_NAME = 'Synths';

/** Engine inst wrapper id for the Synths lane. Stays clear of every
 *  other tonal wrapper (Bass=38842, Keys=38907, Pad=38972,
 *  Guitar=39111) + the transition / loop id bases (40000+, 50000+). */
export const DEFAULT_SYNTHS_VST_ID = 39140;
/** Starting playsample id for the 17 multisample slots. */
export const DEFAULT_SYNTHS_SAMPLE_ID_BASE = 4000;

export interface BuildSynthsInstInput {
  /** The brain's InstrumentDefinition for the Synths slot — used for
   *  `lowLevelType`, `shortName`, catalog id traceability. */
  def: InstrumentDefinition;
  vstId?: number;
  sampleIdBase?: number;
  /** For filename (inst-N.json) ordering. */
  filenameIndex: number;
}

export interface BuiltSynthsInst {
  filename: string;
  json: {
    id: number;
    name: 'Synths';
    shortName: string;
    /** Engine string-to-type map (`Instrument.cpp:117`) recognises
     *  `"leadSynths"` → `Type::leadSynths` → routes to `Synths.h`.
     *  The catalog's specific lowLevel goes into `lowLevelType`. */
    type: 'leadSynths';
    instrumentGroup: 'leadSynths';
    lowLevelType: string;
    isVst: true;
    isSample: false;
    samples: Array<{ id: number; note: string; type: 'longNote'; vst: number }>;
    details: { LUFS: null; octaveAdjustment: null };
    catalogId?: string | number;
  };
  sampleIdRange: { start: number; endInclusive: number };
}

/** Build the engine inst-N.json payload for the Synths lane.
 *  Pure: no FS, no probes. */
export function buildSynthsInst(input: BuildSynthsInstInput): BuiltSynthsInst {
  const vstId = input.vstId ?? DEFAULT_SYNTHS_VST_ID;
  const sampleIdBase = input.sampleIdBase ?? DEFAULT_SYNTHS_SAMPLE_ID_BASE;

  const lowLevelType =
    typeof input.def.lowLevelType === 'string' && input.def.lowLevelType.length > 0
      ? input.def.lowLevelType
      : 'leadSynthsBright';
  const shortName =
    typeof input.def.shortName === 'string' && input.def.shortName.length > 0
      ? input.def.shortName
      : 'Synths';

  const samples: BuiltSynthsInst['json']['samples'] = SYNTHS_NOTE_GRID.map((note, i) => ({
    id: sampleIdBase + i,
    note,
    type: 'longNote',
    vst: vstId,
  }));

  return {
    filename: `inst-${input.filenameIndex}.json`,
    json: {
      id: vstId,
      name: SYNTHS_DISPLAY_NAME,
      shortName,
      type: 'leadSynths',
      instrumentGroup: 'leadSynths',
      lowLevelType,
      isVst: true,
      isSample: false,
      samples,
      details: { LUFS: null, octaveAdjustment: null },
      catalogId: input.def.id,
    },
    sampleIdRange: { start: sampleIdBase, endInclusive: sampleIdBase + SYNTHS_NOTE_GRID.length - 1 },
  };
}

/** True iff the song carries a `Synths` InstrumentDefinition whose
 *  catalog family is `leadSynths`. (docs/54z) */
export function synthsDefinition(
  song: { instrumentDefinitions?: InstrumentDefinition[] | undefined } | undefined,
): InstrumentDefinition | undefined {
  return (song?.instrumentDefinitions ?? []).find(
    (def) =>
      def?.name === SYNTHS_DISPLAY_NAME &&
      (def.instrumentGroup === 'leadSynths' || def.type === 'leadSynths'),
  );
}

// =============================================================
// docs/55a — synths/synthsPlucked (PluckedSynths) lane
// =============================================================
//
// Mirrors the Synths.h-class shape but uses the engine's `"synths"`
// type literal (Instrument.cpp:118 → Type::synths → Synths.h). Same
// padAndSynthNotes 17-slot multisample grid; new vst wrapper id +
// new sample id range to keep the two lanes' ids non-colliding.

export const PLUCKED_SYNTHS_DISPLAY_NAME = 'PluckedSynths';

/** vst wrapper id for the PluckedSynths lane — clear of every other
 *  tonal wrapper (Synths=39140, Bass=38842, Keys=38907, Pad=38972,
 *  Guitar=39111). */
export const DEFAULT_PLUCKED_SYNTHS_VST_ID = 39160;
/** Starting playsample id for the 17 multisample slots. Stays clear
 *  of the Synths range (4000..4016). */
export const DEFAULT_PLUCKED_SYNTHS_SAMPLE_ID_BASE = 4020;

export interface BuildPluckedSynthsInstInput {
  def: InstrumentDefinition;
  vstId?: number;
  sampleIdBase?: number;
  filenameIndex: number;
}

export interface BuiltPluckedSynthsInst {
  filename: string;
  json: {
    id: number;
    name: 'PluckedSynths';
    shortName: string;
    type: 'synths';
    instrumentGroup: 'synths';
    lowLevelType: string;
    isVst: true;
    isSample: false;
    samples: Array<{ id: number; note: string; type: 'longNote'; vst: number }>;
    details: { LUFS: null; octaveAdjustment: null };
    catalogId?: string | number;
  };
  sampleIdRange: { start: number; endInclusive: number };
}

export function buildPluckedSynthsInst(
  input: BuildPluckedSynthsInstInput,
): BuiltPluckedSynthsInst {
  const vstId = input.vstId ?? DEFAULT_PLUCKED_SYNTHS_VST_ID;
  const sampleIdBase = input.sampleIdBase ?? DEFAULT_PLUCKED_SYNTHS_SAMPLE_ID_BASE;

  const lowLevelType =
    typeof input.def.lowLevelType === 'string' && input.def.lowLevelType.length > 0
      ? input.def.lowLevelType
      : 'synthsPlucked';
  const shortName =
    typeof input.def.shortName === 'string' && input.def.shortName.length > 0
      ? input.def.shortName
      : 'PluckedSynths';

  const samples: BuiltPluckedSynthsInst['json']['samples'] = SYNTHS_NOTE_GRID.map(
    (note, i) => ({
      id: sampleIdBase + i,
      note,
      type: 'longNote',
      vst: vstId,
    }),
  );

  return {
    filename: `inst-${input.filenameIndex}.json`,
    json: {
      id: vstId,
      name: PLUCKED_SYNTHS_DISPLAY_NAME,
      shortName,
      type: 'synths',
      instrumentGroup: 'synths',
      lowLevelType,
      isVst: true,
      isSample: false,
      samples,
      details: { LUFS: null, octaveAdjustment: null },
      catalogId: input.def.id,
    },
    sampleIdRange: { start: sampleIdBase, endInclusive: sampleIdBase + SYNTHS_NOTE_GRID.length - 1 },
  };
}

/** True iff the song carries a `PluckedSynths` InstrumentDefinition
 *  whose catalog family is `synths` (the only one we wire in 55a). */
export function pluckedSynthsDefinition(
  song: { instrumentDefinitions?: InstrumentDefinition[] | undefined } | undefined,
): InstrumentDefinition | undefined {
  return (song?.instrumentDefinitions ?? []).find(
    (def) =>
      def?.name === PLUCKED_SYNTHS_DISPLAY_NAME &&
      (def.instrumentGroup === 'synths' || def.type === 'synths'),
  );
}

// =============================================================
// docs/58 — popStrings + popBrass (orchestral) lanes
// =============================================================
//
// Both route to `Synths.h` (Instrument.cpp:120-121 map "popBrass" →
// Type::popBrass and "popStrings" → Type::popStrings; CasperakiEngine.cpp:
// 477-478 dispatches both to the Synths.h class). They share the same
// 17-slot padAndSynthNotes multisample grid as Synths/Keys/Pad. Each lane
// gets its own non-colliding vst wrapper id + sample id range.

export const POP_STRINGS_DISPLAY_NAME = 'PopStrings';
export const POP_BRASS_DISPLAY_NAME = 'PopBrass';

/** vst wrapper ids — clear of Synths=39140, Plucked=39160, Bass=38842,
 *  Keys=38907, Pad=38972, Guitar=39111, transition/loop bases. */
export const DEFAULT_POP_STRINGS_VST_ID = 39180;
export const DEFAULT_POP_BRASS_VST_ID = 39200;
/** Sample id bases — clear of Synths(4000..4016) + Plucked(4020..4036). */
export const DEFAULT_POP_STRINGS_SAMPLE_ID_BASE = 4040;
export const DEFAULT_POP_BRASS_SAMPLE_ID_BASE = 4060;

export interface BuildOrchestralInstInput {
  def: InstrumentDefinition;
  vstId?: number;
  sampleIdBase?: number;
  filenameIndex: number;
}

interface BuiltOrchestralInst<Name extends string, EngineType extends string> {
  filename: string;
  json: {
    id: number;
    name: Name;
    shortName: string;
    type: EngineType;
    instrumentGroup: EngineType;
    lowLevelType: string;
    isVst: true;
    isSample: false;
    samples: Array<{ id: number; note: string; type: 'longNote'; vst: number }>;
    details: { LUFS: null; octaveAdjustment: null };
    catalogId?: string | number;
  };
  sampleIdRange: { start: number; endInclusive: number };
}

function buildOrchestralInst<Name extends string, EngineType extends string>(
  name: Name,
  engineType: EngineType,
  defaultLowLevel: string,
  defaultVstId: number,
  defaultSampleBase: number,
  input: BuildOrchestralInstInput,
): BuiltOrchestralInst<Name, EngineType> {
  const vstId = input.vstId ?? defaultVstId;
  const sampleIdBase = input.sampleIdBase ?? defaultSampleBase;
  const lowLevelType =
    typeof input.def.lowLevelType === 'string' && input.def.lowLevelType.length > 0
      ? input.def.lowLevelType
      : defaultLowLevel;
  const shortName =
    typeof input.def.shortName === 'string' && input.def.shortName.length > 0
      ? input.def.shortName
      : name;
  const samples = SYNTHS_NOTE_GRID.map((note, i) => ({
    id: sampleIdBase + i,
    note,
    type: 'longNote' as const,
    vst: vstId,
  }));
  return {
    filename: `inst-${input.filenameIndex}.json`,
    json: {
      id: vstId,
      name,
      shortName,
      type: engineType,
      instrumentGroup: engineType,
      lowLevelType,
      isVst: true,
      isSample: false,
      samples,
      details: { LUFS: null, octaveAdjustment: null },
      catalogId: input.def.id,
    },
    sampleIdRange: { start: sampleIdBase, endInclusive: sampleIdBase + SYNTHS_NOTE_GRID.length - 1 },
  };
}

export function buildPopStringsInst(input: BuildOrchestralInstInput) {
  return buildOrchestralInst(
    POP_STRINGS_DISPLAY_NAME,
    'popStrings',
    'popHighStringsStaccato',
    DEFAULT_POP_STRINGS_VST_ID,
    DEFAULT_POP_STRINGS_SAMPLE_ID_BASE,
    input,
  );
}

export function buildPopBrassInst(input: BuildOrchestralInstInput) {
  return buildOrchestralInst(
    POP_BRASS_DISPLAY_NAME,
    'popBrass',
    'popBrassBrightBrassSectionStaccato',
    DEFAULT_POP_BRASS_VST_ID,
    DEFAULT_POP_BRASS_SAMPLE_ID_BASE,
    input,
  );
}

export function popStringsDefinition(
  song: { instrumentDefinitions?: InstrumentDefinition[] | undefined } | undefined,
): InstrumentDefinition | undefined {
  return (song?.instrumentDefinitions ?? []).find(
    (def) =>
      def?.name === POP_STRINGS_DISPLAY_NAME &&
      (def.instrumentGroup === 'popStrings' || def.type === 'popStrings'),
  );
}

export function popBrassDefinition(
  song: { instrumentDefinitions?: InstrumentDefinition[] | undefined } | undefined,
): InstrumentDefinition | undefined {
  return (song?.instrumentDefinitions ?? []).find(
    (def) =>
      def?.name === POP_BRASS_DISPLAY_NAME &&
      (def.instrumentGroup === 'popBrass' || def.type === 'popBrass'),
  );
}
