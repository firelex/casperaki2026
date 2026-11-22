// docs/54s — Production wiring for the acoustic Guitar lane.
//
// Brain emits a `Guitar` `InstrumentDefinition` (type=`acousticGuitars`)
// + per-segment `arrangement[seg].overrides.Guitar.bars[].notes` chord
// events whenever the segment-activity rule fires. The engine's
// `Guitar.h::TonalInstrument::processSegment` routes `type: 'chord'`
// events through `getChordNotes` → ≤3 per-note multisample voices on
// the long-notes sampler — the exact path 54m's `noteAbsolute` melody
// already proved audible.
//
// This module builds the engine `inst-N.json` payload for the Guitar
// dynamically: 15 longNote + 15 shortNote multisample slots at the
// chromatic positions `guitarNotes.json` slices (e2..a#5), one dummy
// `fxFretNoise` id, and an empty `virtualGuitaristSamples` array.
// `isStrummer: true` mirrors the legacy field set; the renderer
// consults it only for chord-strum routing, which 54s does NOT emit
// (deferred to a follow-up — see docs/54s "Deferred").
//
// Per-segment overrides are lowered by the existing tonal-bars
// projection in `index.ts::tonalBarsFromBrainBars`, sharing the
// Keys/Pad code path. The chord-type default is `oneOctaveMid`
// (matches Keys) — picks a mid-octave triad which lands inside the
// guitar's e2..a#5 multisample range without transposition tricks.

import type {
  InstrumentDefinition,
  Song,
} from '@casperaki/song-schema';

import {
  OUT_OF_SEGMENT_STRUM_CHORD,
  parseEngineChord,
  virtualGuitaristChordName,
} from './virtual-guitarist-chord.js';

// 15 chromatic notes in the legacy `guitarNotes.json` long/short
// scale render (e2..a#5 with whole-tone gaps). Verified via
// `packages/engine-adapter/data/vst-slice-timings/guitarNotes.json`.
const GUITAR_NOTE_GRID: readonly string[] = [
  'e2', 'g2', 'a#2', 'c#3',
  'e3', 'g3', 'a#3', 'c#4',
  'e4', 'g4', 'a#4', 'c#5',
  'e5', 'g5', 'a#5',
] as const;

export const GUITAR_DISPLAY_NAME = 'Guitar';

/** Engine inst-N.json id for the Guitar wrapper. 39111 mirrors the
 *  54m spike's choice and stays clear of the Bass/Keys/Pad wrapper
 *  ids (38842 / 38907 / 38972), the transition id base (40000+), and
 *  the loop id base (50000+). */
export const DEFAULT_GUITAR_VST_ID = 39111;
/** Starting playsample id for the 30 per-note multisample slots. */
export const DEFAULT_GUITAR_SAMPLE_ID_BASE = 9000;
/** Starting playsample id for the virtualGuitarist chord-strum pool
 *  (docs/54v). Each unique (chord, chordPosition, type) triple
 *  referenced by brain `virtualGuitarist` events gets one entry at
 *  9200+i. Stays clear of the per-note range (9000..9029) and the
 *  fret-noise pool (9100..9107). */
export const DEFAULT_GUITAR_STRUM_ID_BASE = 9200;
/** Starting playsample id for the fret-noise pool. Stays clear of
 *  the per-note range (9000..9029) and leaves room for future
 *  growth. 54s used the single id 9100 for a dummy slot; 54t turns
 *  it into a real 8-slice pool at 9100..9107. */
export const DEFAULT_GUITAR_FRET_NOISE_ID_BASE = 9100;
/** Number of fret-noise slices the prestage script extracts from
 *  `<preset> - Default FX.mp3`. The FX bank is structured as 8 hits
 *  at 4-second intervals across its 33-second duration (verified via
 *  per-second RMS scan in docs/54t); equal 4-second slicing keeps
 *  each hit at the start of its slice. */
export const DEFAULT_GUITAR_FRET_NOISE_COUNT = 8;
/** @deprecated use {@link DEFAULT_GUITAR_FRET_NOISE_ID_BASE}. Kept
 *  as an alias so existing callers / tests keep working unchanged. */
export const DEFAULT_GUITAR_FRET_NOISE_ID = DEFAULT_GUITAR_FRET_NOISE_ID_BASE;

/** docs/54v + 54y — One row of the engine inst's
 *  `virtualGuitaristSamples[]` array. Engine matches:
 *  - chord-strum entries by `(chord, chordPosition, type)` — see
 *    Guitar.h:319-322's primary branch.
 *  - fx entries by `fx` field only (chord/position/type are ignored
 *    by the engine for fx; we still populate them defensively with
 *    the type stem `fx<N>` and chord `C` so JSON dedup keys remain
 *    unique). */
export interface GuitarStrumPoolEntry {
  /** sequential id assigned by the adapter, starting at
   *  {@link DEFAULT_GUITAR_STRUM_ID_BASE}. */
  id: number;
  /** engine chord lookup key — sharp form. Mirrors what the engine
   *  computes via `Guitar.h::ensureSampleMidiNote:252-317`. For fx
   *  entries the field is set to `"C"` as a placeholder; engine
   *  doesn't read it (fx routing is fxName-only). */
  chord: string;
  /** position number as STRING (engine `noteData["chordPosition"]
   *  .isString()` check at SequencerUtils.h:608 forces string-typed
   *  field). `'1'` is the default when brain omits chordPosition. */
  chordPosition: string;
  /** strum event name — `chordLongStrumDown`, `chordShortStrumDown`,
   *  `chordLongStrumUp`, `chordShortStrumUp`. For fx entries the
   *  field carries the fx token (`fx1`..`fx7`) — same value as
   *  {@link fx} — purely for the engine's `type`-key lookup path. */
  type: string;
  /** legacy field — null for chord-strum entries; populated with the
   *  fx token (`fx1`..`fx7`) for fx entries. Engine reads this for
   *  fx routing per Guitar.h:343. */
  fx: string | null;
}

export interface BuildGuitarInstInput {
  /** the brain's `InstrumentDefinition` for the Guitar — used for
   *  `lowLevelType`, `shortName`, catalog id traceability. */
  def: InstrumentDefinition;
  /** override for the inst wrapper id; defaults to {@link DEFAULT_GUITAR_VST_ID}. */
  vstId?: number;
  /** override for the per-note id base; defaults to {@link DEFAULT_GUITAR_SAMPLE_ID_BASE}. */
  sampleIdBase?: number;
  /** override for the dummy fret-noise id (54s back-compat).
   *  Equivalent to setting `fretNoiseIdBase` + `fretNoiseCount=1`. */
  fretNoiseId?: number;
  /** override for the fret-noise pool base id; defaults to
   *  {@link DEFAULT_GUITAR_FRET_NOISE_ID_BASE}. (docs/54t) */
  fretNoiseIdBase?: number;
  /** number of fret-noise slices in the pool; defaults to
   *  {@link DEFAULT_GUITAR_FRET_NOISE_COUNT}. Set to 1 to retain
   *  the 54s dummy-only behaviour. (docs/54t) */
  fretNoiseCount?: number;
  /** docs/54v — pre-built strum-pool entries; one per unique
   *  (chord, chordPosition, type) triple referenced by brain
   *  virtualGuitarist events. Defaults to `[]` (no strums emitted
   *  by brain → empty pool, 54s/54t back-compat). */
  strumPool?: readonly GuitarStrumPoolEntry[];
  /** for filename (inst-N.json) ordering. */
  filenameIndex: number;
}

/** docs/54u — Both `acousticGuitars` and `electricGuitars` engine
 *  inst types ride the same `Guitar.h` class
 *  (`CasperakiEngine.cpp:454-457`). The adapter picks the right
 *  literal based on the brain's `InstrumentDefinition.instrumentGroup`. */
export type GuitarInstType = 'acousticGuitars' | 'electricGuitars';

export interface BuiltGuitarInst {
  filename: string;
  json: {
    id: number;
    name: 'Guitar';
    shortName: string;
    type: GuitarInstType;
    lowLevelType: string;
    instrumentGroup: GuitarInstType;
    isVst: true;
    isSample: false;
    isStrummer: true;
    samples: Array<{
      id: number;
      note: string;
      type: 'longNote' | 'shortNote';
      vst: number;
    }>;
    fx: { fxFretNoise: number[] };
    virtualGuitaristSamples: GuitarStrumPoolEntry[];
    details: { LUFS: null; octaveAdjustment: null };
    catalogId?: string | number;
  };
  /** echoed for prestage / asset-manifest. */
  sampleIdRange: { start: number; endInclusive: number };
  /** docs/54t — the fret-noise id pool the prestage script stages.
   *  Single-element [9100] for 54s callers; 8 elements 9100..9107
   *  by default in 54t. */
  fretNoiseIds: number[];
  /** @deprecated alias for `fretNoiseIds[0]` — kept for 54s callers. */
  fretNoiseId: number;
  /** docs/54v — the strum-pool entries echoed back to the caller for
   *  prestage. Empty when no brain virtualGuitarist events fire. */
  strumPool: GuitarStrumPoolEntry[];
}

/** Build the engine inst-N.json payload for the Guitar lane.
 *  Pure: no FS, no probes. */
export function buildGuitarInst(input: BuildGuitarInstInput): BuiltGuitarInst {
  const vstId = input.vstId ?? DEFAULT_GUITAR_VST_ID;
  const sampleIdBase = input.sampleIdBase ?? DEFAULT_GUITAR_SAMPLE_ID_BASE;
  // Fret-noise pool. Honour the legacy single-id field
  // (`fretNoiseId`) when set; otherwise build a pool of
  // `fretNoiseCount` ids starting at `fretNoiseIdBase`.
  let fretNoiseIds: number[];
  if (typeof input.fretNoiseId === 'number') {
    fretNoiseIds = [input.fretNoiseId];
  } else {
    const base = input.fretNoiseIdBase ?? DEFAULT_GUITAR_FRET_NOISE_ID_BASE;
    const count = input.fretNoiseCount ?? DEFAULT_GUITAR_FRET_NOISE_COUNT;
    fretNoiseIds = Array.from({ length: count }, (_, i) => base + i);
  }
  const lowLevelType =
    typeof input.def.lowLevelType === 'string' && input.def.lowLevelType.length > 0
      ? input.def.lowLevelType
      : 'acousticGuitarsSteelStereo';
  const shortName =
    typeof input.def.shortName === 'string' && input.def.shortName.length > 0
      ? input.def.shortName
      : 'Guitar';
  // docs/54u — instrumentGroup carries the engine inst type. Brain
  // orchestrator writes `instrumentGroup = entry.family` (the
  // catalog family), so a Domino electric def has
  // `instrumentGroup = 'electricGuitars'`. Fall back to acoustic if
  // the brain didn't set it.
  const instType: GuitarInstType =
    input.def.instrumentGroup === 'electricGuitars'
      ? 'electricGuitars'
      : 'acousticGuitars';

  const samples: BuiltGuitarInst['json']['samples'] = [];
  let nextId = sampleIdBase;
  for (const note of GUITAR_NOTE_GRID) {
    samples.push({ id: nextId++, note, type: 'longNote', vst: vstId });
  }
  for (const note of GUITAR_NOTE_GRID) {
    samples.push({ id: nextId++, note, type: 'shortNote', vst: vstId });
  }

  // docs/54v — strum pool. Defensive copy keeps the input read-only;
  // entries are pre-built by `collectStrumPoolEntries` (or supplied
  // directly by tests).
  const strumPool: GuitarStrumPoolEntry[] = (input.strumPool ?? []).map((e) => ({
    id: e.id,
    chord: e.chord,
    chordPosition: e.chordPosition,
    type: e.type,
    fx: e.fx,
  }));

  return {
    filename: `inst-${input.filenameIndex}.json`,
    json: {
      id: vstId,
      name: GUITAR_DISPLAY_NAME,
      shortName,
      type: instType,
      lowLevelType,
      instrumentGroup: instType,
      isVst: true,
      isSample: false,
      isStrummer: true,
      samples,
      fx: { fxFretNoise: [...fretNoiseIds] },
      virtualGuitaristSamples: strumPool,
      details: { LUFS: null, octaveAdjustment: null },
      catalogId: input.def.id,
    },
    sampleIdRange: { start: sampleIdBase, endInclusive: nextId - 1 },
    fretNoiseIds,
    fretNoiseId: fretNoiseIds[0]!,
    strumPool,
  };
}

/** docs/54v + 54y — Walk every Guitar override across the song's
 *  segments exactly as the render engine does, and build the inst's
 *  `virtualGuitaristSamples[]` pool. Two entry kinds:
 *
 *  - **Chord-strum entries** (54v): event starts with `chord`. The engine
 *    IGNORES the event's own `chord` field: it takes the structure chord at
 *    the strum's beat (Tonal.h getChordAtTime, with the pattern bars
 *    repeating modulo their count over the segment's bars) and looks the
 *    strum up as `<sharp root><collapsed suffix>_<position>_<type>`
 *    (Guitar.h strumSampleKey). So each entry's `chord` is that collapsed
 *    name ("Fmaj7" → "F7"); a key missing from the pool aborts the rest of
 *    the segment's strums in the engine. Disk file lives at
 *    `<preset>/chords/<chord>_Pos_<N>_<Long|Short>Strum<Down|Up>.mp3`
 *    (root re-spelled with the library's accidentals by the stager).
 *  - **fx entries** (54y): event matches `/^fx\d+$/` (the legacy
 *    keeps fx1..fx7; allowed-set + substitution is enforced upstream
 *    in `virtual-guitarist-bank.ts::postProcessVirtualGuitaristPattern`).
 *    Engine matches by `fx` field only (Guitar.h:343). Disk file
 *    lives at `<preset>/fx/<fx>.mp3`.
 *
 *  Throws on a structure chord the engine cannot parse.
 *
 *  Deterministic given a stable brain Song:
 *  - Dedup by `<chord>|<chordPosition>|<type>` for chord entries,
 *    `fx|<event>` for fx entries.
 *  - Sort: chord entries first (chord asc, position asc, type asc),
 *    then fx entries (fx name asc).
 *  - Sequential ids from {@link DEFAULT_GUITAR_STRUM_ID_BASE}. */
export function collectStrumPoolEntries(
  song: Song,
  idBase: number = DEFAULT_GUITAR_STRUM_ID_BASE,
  laneName: string = GUITAR_DISPLAY_NAME,
): GuitarStrumPoolEntry[] {
  const seenChord = new Map<
    string,
    { kind: 'chord'; chord: string; chordPosition: string; type: string }
  >();
  const seenFx = new Map<string, { kind: 'fx'; fxName: string }>();
  for (const seg of song.songStructure ?? []) {
    const ar = (song.arrangement ?? {})[seg.name];
    if (!ar) continue;
    // Lowering marks the lane inactive on an explicit `false`; the engine
    // then skips the segment (isInstrumentInSegment).
    if ((ar.instruments as Record<string, unknown> | undefined)?.[laneName] === false) continue;
    const guitarOv = (ar.overrides as Record<string, { bars?: Array<{ notes?: Record<string, unknown[]> }> }> | undefined)?.[laneName];
    const patternBars = guitarOv?.bars ?? [];
    if (patternBars.length === 0) continue;
    const segBars = (seg.bars ?? []) as Array<{ chords?: unknown }>;
    for (let barIndex = 0; barIndex < segBars.length; barIndex++) {
      const bar = patternBars[barIndex % patternBars.length];
      for (const [timeKey, events] of Object.entries(bar?.notes ?? {})) {
        for (const ev of events as Array<{
          type?: string;
          event?: string;
          chordPosition?: string;
        }>) {
          if (ev?.type !== 'virtualGuitarist' || typeof ev.event !== 'string') continue;
          if (ev.event.startsWith('chord')) {
            const chord = strumChordAtTime(segBars, barIndex, Number.parseFloat(timeKey), seg.name);
            const chordPosition =
              typeof ev.chordPosition === 'string' && ev.chordPosition.length > 0
                ? ev.chordPosition
                : '1';
            const key = `${chord}|${chordPosition}|${ev.event}`;
            if (!seenChord.has(key)) {
              seenChord.set(key, {
                kind: 'chord',
                chord,
                chordPosition,
                type: ev.event,
              });
            }
          } else if (/^fx\d+$/.test(ev.event)) {
            const key = `fx|${ev.event}`;
            if (!seenFx.has(key)) {
              seenFx.set(key, { kind: 'fx', fxName: ev.event });
            }
          }
        }
      }
    }
  }
  const chordSorted = [...seenChord.values()].sort((a, b) => {
    if (a.chord !== b.chord) return a.chord < b.chord ? -1 : 1;
    if (a.chordPosition !== b.chordPosition)
      return a.chordPosition < b.chordPosition ? -1 : 1;
    if (a.type !== b.type) return a.type < b.type ? -1 : 1;
    return 0;
  });
  const fxSorted = [...seenFx.values()].sort((a, b) =>
    a.fxName < b.fxName ? -1 : a.fxName > b.fxName ? 1 : 0,
  );
  const out: GuitarStrumPoolEntry[] = [];
  let nextId = idBase;
  for (const s of chordSorted) {
    out.push({
      id: nextId++,
      chord: s.chord,
      chordPosition: s.chordPosition,
      type: s.type,
      fx: null,
    });
  }
  for (const s of fxSorted) {
    out.push({
      id: nextId++,
      // Placeholder chord/position/type fields — engine ignores them
      // for fx entries (Guitar.h:343 matches on `sample["fx"]` alone).
      // We set them to stable values so JSON dedup keys remain unique
      // across runs.
      chord: 'C',
      chordPosition: '1',
      type: s.fxName,
      fx: s.fxName,
    });
  }
  return out;
}

/** Tonal.h getChordAtTime, reduced to the strum key's chord name: the
 *  structure chord at `time` beats into bar `barIndex` (time rolls over into
 *  following bars), collapsed per Guitar.h virtualGuitaristSuffix. A beat
 *  past the segment's last bar is the engine's invalid chord, keyed "C". */
function strumChordAtTime(
  segBars: ReadonlyArray<{ chords?: unknown }>,
  barIndex: number,
  time: number,
  segName: string,
): string {
  if (!Number.isFinite(time)) {
    throw new Error(`engine-adapter: Guitar strum in segment "${segName}" has a non-numeric beat key`);
  }
  while (time >= 4) { time -= 4; barIndex++; }
  if (barIndex >= segBars.length) return OUT_OF_SEGMENT_STRUM_CHORD;
  const chords = segBars[barIndex]!.chords;
  const beat = Math.trunc(time);
  const symbol = Array.isArray(chords) ? chords[beat] : undefined;
  if (typeof symbol !== 'string') {
    throw new Error(
      `engine-adapter: segment "${segName}" bar ${barIndex} has no chord at beat ${beat} for a Guitar strum`,
    );
  }
  return virtualGuitaristChordName(parseEngineChord(symbol));
}

/** True iff the song carries a `Guitar` `InstrumentDefinition` whose
 *  catalog family is `acousticGuitars` OR `electricGuitars` (docs/54u).
 *  The brain orchestrator writes `instrumentGroup = entry.family`
 *  (the catalog family) and `type = entry.lowLevel` (the specific
 *  articulation — e.g. `acousticGuitarsNylonStereo` or
 *  `electricGuitarsLpChorusStereo`), so we match on
 *  `instrumentGroup`, NOT `type`. */
export function guitarDefinition(song: Song): InstrumentDefinition | undefined {
  return (song.instrumentDefinitions ?? []).find(
    (def) =>
      def?.name === GUITAR_DISPLAY_NAME &&
      (def.instrumentGroup === 'acousticGuitars' ||
        def.instrumentGroup === 'electricGuitars' ||
        def.type === 'acousticGuitars' ||
        def.type === 'electricGuitars'),
  );
}
