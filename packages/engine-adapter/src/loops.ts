// docs/54r — Production wiring for the percussion-loop (`Loop`) lane.
//
// The brain (`@casperaki/arrangement`) emits one `InstrumentDefinition`
// per chosen loop with `type: 'percussionLoops'` plus the per-segment
// `arrangement[seg].instruments[<loopName>] = true/false` flag for the
// legacy verse-only activation rule (ArrangementsClass.js:681-708).
// This module is the deterministic, FS-free lowering: it walks the
// brain's instrument definitions, asks the caller to probe each
// staged sample's duration, and emits one engine-ready `inst-N.json`
// per loop with `type: 'percussionLoops'`, `details.bpm`,
// `details.duration`, and the playSample URL.
//
// The engine's `Loop.h` ctor reads `details.bpm` (string-parsed) and
// `details.duration` (number); the runtime path lives in `Loop.h
// ::createSegmentClip` which tiles the staged sample across each
// active segment via `setNumberOfLoops(ceil(seg/source))` (see
// docs/54o §"Engine patch 04"). Per-segment routing goes through
// `arrangement[seg].instruments[<loopName>]`, lookup with
// `isInstrumentInSegment` which defaults to true on a missing key —
// so the adapter MUST emit an explicit `false` on non-active segments
// or the engine would fire the loop everywhere.

import type {
  InstrumentDefinition,
  Song,
} from '@casperaki/song-schema';

/** Match the engine's accepted `Instrument::getType` keys for the
 *  Loop dispatch path (`Instrument.cpp:125-126`). Brain emits
 *  `'percussionLoops'`; both spellings are accepted so a future
 *  brain that uses the bare `'percussion'` key still lowers. */
const LOOP_TYPES: ReadonlySet<string> = new Set(['percussionLoops', 'percussion']);

export interface LoopProbeResult {
  /** seconds; null when probe failed or sample not staged. */
  durationSeconds: number | null;
  /** relative path under the sample library root, for adapter
   *  diagnostics + the spike's prestage script. */
  sourcePath?: string;
  /** populated when the probe could not return a duration; surfaced
   *  verbatim in the adapter diagnostic so operators can tell the
   *  difference between "no library mounted" and "ffprobe failed". */
  reason?: string;
}

/** Caller-supplied probe — synchronous so the adapter stays pure of
 *  child_process / FS. The spike CLI wraps `ffprobe` + a duration
 *  cache; tests pass a Map-backed stub. */
export type LoopSampleProbe = (def: InstrumentDefinition) => LoopProbeResult;

export interface BuildLoopInstInput {
  song: Song;
  /** sequential id assigned by the caller — picked above the
   *  Phase-2 fixture range and the transition base (`40000`). */
  playsampleId: number;
  /** for filename (inst-N.json) ordering. */
  filenameIndex: number;
  /** the brain's `InstrumentDefinition` for this loop. */
  def: InstrumentDefinition;
  /** ffprobed duration in seconds; required for engine `details.duration`. */
  durationSeconds: number;
  /** echoed onto the inst payload so the prestage script can resolve
   *  the source MP3 → playsample-<id>.ogg without re-querying the
   *  catalog. */
  sourcePath?: string;
}

export interface BuiltLoopInst {
  filename: string;
  json: {
    id: number;
    name: string;
    shortName: string;
    type: 'percussionLoops';
    lowLevelType: string;
    isSample: true;
    isVst: false;
    /** Engine reads `details.bpm` via `std::stoi(...toString())`,
     *  so it accepts either a number or a numeric string. We emit
     *  a number for readability. */
    details: { bpm: number; duration: number };
    /** Sample download path the engine's `SamplesDownloadTask`
     *  consumes via the inst's `urls` array, matching legacy
     *  `Loop` inst payloads from `LibWASM/.../songs/1`. */
    urls: string[];
    /** echoed from catalog for prestage + diagnostics; engine ignores. */
    sourcePath?: string;
    catalogId?: string | number;
  };
  blockKey: string;
}

/** The catalog `lowLevel` for percussion loops carries a bpm-range
 *  suffix (e.g. `percussionLoopsAcoustic_120-150bpm`) because the legacy
 *  library ships per-bpm pre-stretched variants of each loop. The engine
 *  taxonomy is bpm-agnostic: both `FX::getInstrumentTargetVolume` and
 *  `getFamilyForLowLevelType` (casperaki_engine Source/FX.h) key on the
 *  bare `percussionLoopsAcoustic` / `percussionLoopsElectronic`. If we
 *  pass the suffixed string through, the engine misses BOTH lookups —
 *  the loop falls through to the unity (0 dB) default instead of the
 *  legacy genre-dependent cut (-7..-12 dB) and is mis-grouped for FX
 *  submix routing. Strip the suffix before emit; bpm is preserved
 *  separately in `details.bpm`, so nothing is lost. */
const LOOP_BPM_SUFFIX = /_\d+-\d+bpm$/;

export function normalizeLoopLowLevelType(raw: string): string {
  return raw.replace(LOOP_BPM_SUFFIX, '');
}

/** Build the inst-N.json payload for a single Loop instrument. */
export function buildLoopInst(input: BuildLoopInstInput): BuiltLoopInst {
  const { def, playsampleId, filenameIndex, durationSeconds, sourcePath } = input;
  const bpm = readBpm(def, input.song);
  const lowLevelType = normalizeLoopLowLevelType(
    typeof def.lowLevelType === 'string' && def.lowLevelType.length > 0
      ? def.lowLevelType
      : 'percussionLoopsAcoustic',
  );
  const shortName =
    typeof def.shortName === 'string' && def.shortName.length > 0
      ? def.shortName
      : def.name;
  return {
    filename: `inst-${filenameIndex}.json`,
    blockKey: def.name,
    json: {
      id: playsampleId,
      name: def.name,
      shortName,
      type: 'percussionLoops',
      lowLevelType,
      isSample: true,
      isVst: false,
      details: { bpm, duration: durationSeconds },
      urls: [`/playSample/${playsampleId}`],
      sourcePath,
      catalogId: def.id,
    },
  };
}

/** Filter a Song's `instrumentDefinitions` to those that should be
 *  lowered as Loop insts. Stable iteration order (filter preserves
 *  input order; the orchestrator emits brain-side definitions in
 *  a deterministic order — last item is the loop). */
export function loopDefinitions(song: Song): InstrumentDefinition[] {
  return (song.instrumentDefinitions ?? []).filter((def) => {
    if (!def || typeof def.type !== 'string') return false;
    return LOOP_TYPES.has(def.type);
  });
}

/** True iff the segment has the loop's `instruments[loopName]` flag
 *  set to a literal `true`. The engine's `isInstrumentInSegment`
 *  defaults to true on missing — that default is for instruments the
 *  brain forgot to declare. For loops we ONLY trust an explicit true
 *  (the orchestrator declares the key on every segment, defaulting to
 *  the activity gate's result). */
export function segmentHasLoopActive(
  song: Song,
  segmentName: string,
  loopName: string,
): boolean {
  const ar = (song.arrangement ?? {})[segmentName];
  if (!ar) return false;
  const instruments = (ar.instruments ?? {}) as Record<string, boolean>;
  return instruments[loopName] === true;
}

function readBpm(def: InstrumentDefinition, song: Song): number {
  const dt = def.details as { bpm?: unknown } | undefined;
  const raw = dt?.bpm;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw === 'string' && raw.length > 0) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  // Fall back to the song's bpm — the legacy library's per-bpm
  // pre-stretched variants mean source bpm ≡ song bpm by construction.
  return song.bpm;
}
