// Multisample resolver — docs/54l.
//
// Given a catalog `family` (e.g. "basses" / "keys" / "popStrings") and
// the engine's per-family inst-N.json `samples` array (e.g. 17 entries
// for Synths or 16 for Bass, each with `id`, `note`, `type`), return
// one slice-timing per engine sample slot. The timing comes from the
// legacy `<family>Notes.json` files we imported into
// packages/engine-adapter/data/vst-slice-timings/.
//
// The resolver is pure — it takes the parsed timing JSON + the inst
// samples array as inputs and returns per-slot resolution records. The
// staging script (stage-multisample.mjs) does the ffmpeg slicing + file
// I/O.
//
// Per-slot resolution shape:
//   { slot: { id, note, type }, status: 'resolved', sliceStart, sliceEnd, timingIndex }
//   { slot: { id, note, type }, status: 'unresolved', reason }
//
// Family-level summary:
//   { family, timingName, resolved: N, unresolved: M, total: N+M,
//     slots: [...] }

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseMmSsHh } from './audio-slice.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The data dir lives in @casperaki/engine-adapter so the timing JSONs
// are colocated with the inst-N.json fixtures (both originate in the
// legacy engine-js backend). The path is computed from this file's
// location to keep the engine-spike scripts self-contained — no
// `package.json#exports` dance.
const DEFAULT_DATA_DIR = resolve(
  __dirname,
  '../../../../packages/engine-adapter/data/vst-slice-timings',
);

/**
 * @typedef {{
 *   id: number;
 *   note: string;
 *   type: string;
 * }} EngineSampleSlot
 */

/**
 * @typedef {{
 *   start: string;
 *   end: string;
 *   type: 'longNote' | 'shortNote' | 'IGNORE' | string;
 *   note: string;
 * }} LegacyTimingEntry
 */

/**
 * @typedef {{
 *   slot: EngineSampleSlot;
 *   status: 'resolved';
 *   sliceStart: number;
 *   sliceEnd: number;
 *   timingIndex: number;
 *   timingNote: string;
 *   timingType: string;
 * } | {
 *   slot: EngineSampleSlot;
 *   status: 'unresolved';
 *   reason: string;
 * }} MultisampleSlotResolution
 */

/**
 * @typedef {{
 *   family: string;
 *   timingName: string | null;
 *   timingPath: string | null;
 *   resolvedCount: number;
 *   unresolvedCount: number;
 *   total: number;
 *   slots: MultisampleSlotResolution[];
 *   reason?: string;
 * }} MultisampleResolution
 */

let cachedMap;
let cachedTimings = new Map();

/**
 * Load the catalog-family → timing-name mapping. Cached after first
 * call. Override the data dir for tests.
 *
 * @param {{ dataDir?: string; readFile?: (p: string) => string }} [opts]
 * @returns {Record<string, string>}
 */
export function loadFamilyTimingMap({ dataDir = DEFAULT_DATA_DIR, readFile = (p) => readFileSync(p, 'utf-8') } = {}) {
  if (cachedMap && dataDir === DEFAULT_DATA_DIR) return cachedMap;
  const path = resolve(dataDir, 'family-timing-map.json');
  const raw = JSON.parse(readFile(path));
  const map = raw?.families ?? {};
  if (dataDir === DEFAULT_DATA_DIR) cachedMap = map;
  return map;
}

/**
 * Load one timing JSON by name (e.g. "pianoNotes" → array of slice
 * entries). Cached after first load.
 *
 * @param {string} timingName
 * @param {{ dataDir?: string; readFile?: (p: string) => string }} [opts]
 * @returns {LegacyTimingEntry[]}
 */
export function loadTiming(timingName, { dataDir = DEFAULT_DATA_DIR, readFile = (p) => readFileSync(p, 'utf-8') } = {}) {
  const cacheKey = `${dataDir}|${timingName}`;
  if (cachedTimings.has(cacheKey)) return cachedTimings.get(cacheKey);
  const path = resolve(dataDir, `${timingName}.json`);
  const arr = JSON.parse(readFile(path));
  if (!Array.isArray(arr)) {
    throw new Error(`multisample-resolver: timing "${timingName}" did not parse to an array (path=${path})`);
  }
  cachedTimings.set(cacheKey, arr);
  return arr;
}

/**
 * Test-only cache reset.
 */
export function _resetMultisampleResolverCache() {
  cachedMap = undefined;
  cachedTimings = new Map();
}

/**
 * Lower-case a note string for matching. Legacy timing JSONs use lower-
 * case ("c2", "d#2"); fixtures use the same convention. Be defensive:
 * trim and lowercase.
 *
 * @param {string} note
 * @returns {string}
 */
function normNote(note) {
  return String(note ?? '').trim().toLowerCase();
}

/**
 * Build a (note, type) → list of timing-index map for one timing array.
 * If the timing has duplicate (note, type) pairs (e.g. legacy
 * laNaSingerNotes pads), they queue in source order — each call to
 * `take()` returns the next available index.
 *
 * @param {LegacyTimingEntry[]} timing
 * @returns {{ take: (note: string, type: string) => number | undefined; remainingFor: (note: string, type: string) => number }}
 */
function buildTimingIndex(timing) {
  /** @type {Map<string, number[]>} */
  const queues = new Map();
  for (let i = 0; i < timing.length; i++) {
    const t = timing[i];
    if (!t || t.type === 'IGNORE') continue;
    const key = `${normNote(t.note)}|${String(t.type)}`;
    const q = queues.get(key) ?? [];
    q.push(i);
    queues.set(key, q);
  }
  return {
    take(note, type) {
      const key = `${normNote(note)}|${String(type)}`;
      const q = queues.get(key);
      if (!q || q.length === 0) return undefined;
      return q.shift();
    },
    remainingFor(note, type) {
      const key = `${normNote(note)}|${String(type)}`;
      return queues.get(key)?.length ?? 0;
    },
  };
}

/**
 * Resolve per-slot slice timings for a tonal family.
 *
 * Match policy: for each engine sample slot in `samples` (in source
 * order), pop the first unused timing entry whose (note, type) matches
 * the slot's (note, type). Slots with no matching timing entry come
 * back as `unresolved` with a precise reason. Timing entries with
 * `type: "IGNORE"` are skipped (legacy mp3split filter — see
 * casperaki2-engine-js/api/v1.0/controllers/vstSamples.js:354).
 *
 * @param {{
 *   family: string;
 *   samples: EngineSampleSlot[];
 *   familyTimingMap?: Record<string, string>;
 *   loadTimingForName?: (name: string) => LegacyTimingEntry[];
 *   dataDir?: string;
 *   firstNote?: string;
 *   tuneCents?: number;
 * }} opts
 * @returns {MultisampleResolution}
 */
export function resolveMultisampleSlots({
  family,
  samples,
  familyTimingMap,
  loadTimingForName,
  dataDir,
  firstNote,
  tuneCents,
}) {
  const map = familyTimingMap ?? loadFamilyTimingMap(dataDir ? { dataDir } : undefined);
  const timingName = map?.[family];

  if (!timingName) {
    const slots = (samples ?? []).map((s) => ({
      slot: { id: s.id, note: s.note, type: s.type },
      status: /** @type {const} */ ('unresolved'),
      reason: `no timing JSON mapped for family "${family}" in family-timing-map.json`,
    }));
    return {
      family,
      timingName: null,
      timingPath: null,
      resolvedCount: 0,
      unresolvedCount: slots.length,
      total: slots.length,
      slots,
      reason: `family "${family}" is not in the timing map (drum/fx families don't have per-note multisamples; tonal families need an explicit entry).`,
    };
  }

  const loader = loadTimingForName ?? ((name) => loadTiming(name, dataDir ? { dataDir } : undefined));
  const timing = loader(timingName);
  const idx = buildTimingIndex(timing);
  // A recording that starts below the table's first note (the library's multisampleMetadata.json: "BA Brooks 1" starts
  // on F#, not C; owner 2026-11-28 "offset the notes in the player"): every slot takes the slice that many further on.
  const shift = firstNote === undefined ? 0 : slicesBeforeFirst(timing, firstNote, timingName);

  /** @type {MultisampleSlotResolution[]} */
  const slots = [];
  let resolvedCount = 0;
  let unresolvedCount = 0;

  for (const s of samples ?? []) {
    if (!s || typeof s.id !== 'number' || typeof s.note !== 'string' || typeof s.type !== 'string') {
      slots.push({
        slot: /** @type {EngineSampleSlot} */ (s ?? { id: -1, note: '?', type: '?' }),
        status: 'unresolved',
        reason: 'slot is missing id/note/type',
      });
      unresolvedCount++;
      continue;
    }
    const tIndex = idx.take(s.note, s.type);
    if (tIndex === undefined) {
      slots.push({
        slot: { id: s.id, note: s.note, type: s.type },
        status: 'unresolved',
        reason: `no timing entry left for (note=${s.note}, type=${s.type}) in ${timingName}.json`,
      });
      unresolvedCount++;
      continue;
    }
    const t = timing[tIndex + shift];
    if (!t || t.type !== s.type) {
      // Past the recording's top (it starts `shift` notes early): the lowering drops the slot, so the sampler stretches its top real note (owner 2026-11-28).
      slots.push({ slot: { id: s.id, note: s.note, type: s.type }, status: 'unresolved', reason: `the recording starts ${shift} slice(s) early (first note ${firstNote}), so it has no slice for (note=${s.note}, type=${s.type})`, pastRecording: true });
      unresolvedCount++;
      continue;
    }
    const sliceStart = parseMmSsHh(t.start);
    const sliceEnd = parseMmSsHh(t.end);
    slots.push({
      slot: { id: s.id, note: s.note, type: s.type },
      status: 'resolved',
      sliceStart,
      sliceEnd,
      timingIndex: tIndex,
      timingNote: normNote(t.note),
      timingType: String(t.type),
      // The library's measured correction for a recording out of tune (multisampleMetadata.json): the players raise
      // the slice by this many cents (a sampler's fine tune).
      ...(tuneCents ? { tuneCents } : {}),
    });
    resolvedCount++;
  }

  return {
    family,
    timingName,
    timingPath: resolve(dataDir ?? DEFAULT_DATA_DIR, `${timingName}.json`),
    resolvedCount,
    unresolvedCount,
    total: slots.length,
    slots,
  };
}

const PITCH_CLASSES = { c: 0, 'c#': 1, db: 1, d: 2, 'd#': 3, eb: 3, e: 4, f: 5, 'f#': 6, gb: 6, g: 7, 'g#': 8, ab: 8, a: 9, 'a#': 10, bb: 10, b: 11 };

/** How many slices before the table's first note a recording starting on `firstNote` begins (the table steps by a
 *  fixed interval: bassNotes by three semitones). Throws for a note that is not on that grid. */
function slicesBeforeFirst(timing, firstNote, timingName) {
  const pc = (n) => {
    const m = /^([a-g](?:#|b)?)/iu.exec(String(n).trim());
    const v = m ? PITCH_CLASSES[m[1].toLowerCase()] : undefined;
    if (v === undefined) throw new Error(`multisample: "${n}" is not a note`);
    return v;
  };
  const real = timing.filter((t) => t.type !== 'IGNORE');
  if (real.length < 2) throw new Error(`multisample: ${timingName}.json has too few notes to shift`);
  const step = (pc(real[1].note) - pc(real[0].note) + 12) % 12;
  const below = (pc(real[0].note) - pc(firstNote) + 12) % 12;
  if (step === 0 || below % step !== 0) {
    throw new Error(`multisample: a recording starting on ${firstNote} does not fit ${timingName}.json's ${step}-semitone steps from ${real[0].note}`);
  }
  return below / step;
}

