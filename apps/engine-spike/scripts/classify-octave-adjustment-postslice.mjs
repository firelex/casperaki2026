#!/usr/bin/env node
// docs/58c-fix — Per-catalog-row octave classifier (legacy-faithful,
// post-slice).
//
// The original 58c classifier (classify-octave-adjustment-catalog.mjs)
// ran librosa.pyin on the catalog canonical MP3 directly — but those
// canonicals are chromatic-scale recordings that the prestage pipeline
// slices into per-slot audio via `audio-slice.mjs` + the legacy
// mp3split timings under `packages/engine-adapter/data/vst-slice-timings/`.
// The whole-file fundamental returned is the LOWEST sustained note in
// the scale, NOT the slot's audio. That's why the original classifier
// reported every bass row at adj=+1 or +2 — bass canonicals start at
// C1/C2 — and why plumbing those values into the engine over-shifted
// the rendered audio by 1-2 octaves on top of an already-correct
// per-slot slicing.
//
// This rewrite mirrors the legacy
// `casperaki1/calculateOctaveAdjustmentsAndSaveToDatabase.js:84-89`
// behaviour exactly: classify the C3 multisample SLOT, not the raw
// preset.
//
// Algorithm per catalog row:
//   1. Look up canonical disk path from sample-library.audit.json#matched
//   2. Look up family slice timings from
//      `packages/engine-adapter/data/vst-slice-timings/family-timing-map.json`
//      + the per-family timing JSON (e.g. `bassNotes.json`)
//   3. Find the slot whose `note` is nearest to C3 (the legacy ran on
//      c3 exactly; guitarNotes has no c3, so we use c#3 and adjust the
//      expected fundamental). Use the longNote variant when available.
//   4. Call `prepareNormalizedSlice` to cut that time-range out of the
//      canonical → cached Ogg.
//   5. Batch-pYIN the resulting Ogg files.
//   6. adj = -round(log2(detected_F0 / expected_slot_freq))
//      with the same ±0.25-octave tolerance the canonical-mode
//      classifier used. Outside-tolerance → adj=0 ("Unknown" in legacy).
//
// Writes apps/engine-spike/out/octave-adjustment-per-row-postslice.json.
// Same shape as the original per-row map so the adapter doesn't need
// any wiring change once we point it at this file.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENGINE_SPIKE = resolve(__dirname, '..');
const REPO = resolve(ENGINE_SPIKE, '../..');

const ENV_FILE = join(ENGINE_SPIKE, '.env');
if (existsSync(ENV_FILE) && process.loadEnvFile) process.loadEnvFile(ENV_FILE);
const SAMPLE_LIB = process.env.CASPERAKI_SAMPLE_LIBRARY_ROOT;
if (!SAMPLE_LIB || !existsSync(SAMPLE_LIB)) {
  console.error(`CASPERAKI_SAMPLE_LIBRARY_ROOT missing or unreadable`);
  process.exit(2);
}

const SLICE_CACHE_DIR =
  process.env.CASPERAKI_AUDIO_CACHE_ROOT ||
  '/mnt/d/casperaki-cache/audio-normalized';
const SLICE_OUT_DIR = join(SLICE_CACHE_DIR, 'octave-classifier-slices');
mkdirSync(SLICE_OUT_DIR, { recursive: true });

// CLI
const args = process.argv.slice(2);
let outPath = join(ENGINE_SPIKE, 'out', 'octave-adjustment-per-row-postslice.json');
let limit = Infinity;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out' && i + 1 < args.length) outPath = resolve(args[++i]);
  else if (args[i] === '--limit' && i + 1 < args.length) limit = Number.parseInt(args[++i], 10);
}

// Loads
const CATALOG = JSON.parse(readFileSync(
  join(REPO, 'packages/arrangement/data/instrument-catalog.snapshot.json'), 'utf-8'));
const AUDIT = JSON.parse(readFileSync(
  join(REPO, 'packages/arrangement/data/sample-library.audit.json'), 'utf-8'));
const FAMILY_TIMING_MAP = JSON.parse(readFileSync(
  join(REPO, 'packages/engine-adapter/data/vst-slice-timings/family-timing-map.json'),
  'utf-8'));

const timingCache = new Map();
function loadTimings(timingName) {
  if (timingCache.has(timingName)) return timingCache.get(timingName);
  const p = join(REPO, 'packages/engine-adapter/data/vst-slice-timings', `${timingName}.json`);
  const t = JSON.parse(readFileSync(p, 'utf-8'));
  timingCache.set(timingName, t);
  return t;
}

const matchedById = new Map(AUDIT.matched.map((m) => [m.catalogId, m]));

const TONAL_FAMILIES = new Set([
  'basses', 'keys', 'synths', 'leadSynths',
  'acousticGuitars', 'electricGuitars',
  'popBrass', 'popStrings', 'orchestral', 'vocals',
]);

const NOTE_NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];
function midiFromNoteName(n) {
  const m = /^([a-g]#?)(-?\d+)$/u.exec(n.toLowerCase());
  if (!m) throw new Error(`bad note: ${n}`);
  return NOTE_NAMES.indexOf(m[1]) + (Number.parseInt(m[2], 10) + 1) * 12;
}
function hzFromMidi(m) { return 440 * Math.pow(2, (m - 69) / 12); }
const C3_MIDI = 48;
const C3_HZ = hzFromMidi(C3_MIDI); // 130.8128

// Tolerance — same as the canonical-mode classifier. Reject ratios
// further than this from an integer-octave boundary (returns 0).
const RATIO_TOLERANCE_OCTAVES = 0.25;
function classifyByOctaveRatio(detectedHz, expectedHz) {
  if (!detectedHz || detectedHz <= 0 || !expectedHz || expectedHz <= 0) return null;
  const octaves = Math.log2(detectedHz / expectedHz);
  const rounded = Math.round(octaves);
  if (Math.abs(octaves - rounded) > RATIO_TOLERANCE_OCTAVES) return null;
  const adj = -rounded;
  return Math.abs(adj) > 4 ? null : adj;
}

// "mm.ss.hh" → seconds (legacy mp3split format)
function parseMmSsHh(s) {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?$/u.exec(s);
  if (!m) throw new Error(`bad timing: ${s}`);
  const mm = Number.parseInt(m[1], 10);
  const ss = Number.parseFloat(m[2] + (m[3] ? `.${m[3]}` : ''));
  return mm * 60 + ss;
}

function pickC3SlotTiming(timings) {
  // Prefer longNote, exact c3. Otherwise longNote nearest c3 (by midi
  // distance). Tracks the slot's note so the expected fundamental
  // matches the slot label (not c3) when we fall back to e.g. c#3.
  let best = null;
  let bestDist = Infinity;
  for (const t of timings) {
    if (t.type !== 'longNote') continue;
    if (!t.note) continue;
    let midi;
    try { midi = midiFromNoteName(t.note); } catch { continue; }
    const dist = Math.abs(midi - C3_MIDI);
    if (dist < bestDist) { best = t; bestDist = dist; }
  }
  return best;
}

const { prepareNormalizedSlice } = await import('./lib/audio-slice.mjs');

// Walk tonal rows
const tonalRows = CATALOG.entries.filter((e) => TONAL_FAMILIES.has(e.family));
console.error(`[postslice] ${tonalRows.length} tonal rows to classify`);

const rows = [];
let cap = 0;
for (const e of tonalRows) {
  if (cap >= limit) break;
  const m = matchedById.get(e.id);
  if (!m) {
    rows.push({ id: e.id, family: e.family, lowLevel: e.lowLevel,
      library: e.library, preset: e.preset, skipReason: 'no-disk-match' });
    continue;
  }
  const fullPath = join(SAMPLE_LIB, m.matchedPath);
  if (!existsSync(fullPath)) {
    rows.push({ id: e.id, family: e.family, lowLevel: e.lowLevel,
      library: e.library, preset: e.preset, matchedPath: m.matchedPath,
      skipReason: 'disk-file-missing' });
    continue;
  }
  const timingName = FAMILY_TIMING_MAP.families[e.family];
  if (!timingName) {
    rows.push({ id: e.id, family: e.family, lowLevel: e.lowLevel,
      library: e.library, preset: e.preset, matchedPath: m.matchedPath,
      skipReason: 'no-timing-for-family' });
    continue;
  }
  const slot = pickC3SlotTiming(loadTimings(timingName));
  if (!slot) {
    rows.push({ id: e.id, family: e.family, lowLevel: e.lowLevel,
      library: e.library, preset: e.preset, matchedPath: m.matchedPath,
      skipReason: 'no-c3-slot-in-timings' });
    continue;
  }
  const sliceStart = parseMmSsHh(slot.start);
  const sliceEnd = parseMmSsHh(slot.end);
  const expectedHz = hzFromMidi(midiFromNoteName(slot.note));
  rows.push({
    id: e.id, family: e.family, lowLevel: e.lowLevel,
    library: e.library, preset: e.preset, matchedPath: m.matchedPath,
    fullPath, sliceStart, sliceEnd, slotNote: slot.note,
    slotType: slot.type, expectedHz,
  });
  cap++;
}

const toSlice = rows.filter((r) => !r.skipReason);
console.error(`[postslice] ${toSlice.length} rows ready to slice + pYIN, ${rows.length - toSlice.length} skipped`);

// Slice each row's c3 chunk
let sliced = 0;
let sliceErrors = 0;
for (const row of toSlice) {
  const r = prepareNormalizedSlice({
    sourcePath: row.fullPath,
    sliceStart: row.sliceStart,
    sliceEnd: row.sliceEnd,
    cacheDir: SLICE_OUT_DIR,
  });
  if (r.kind !== 'transcoded' && r.kind !== 'cached') {
    row.sliceError = r.error || r.kind;
    sliceErrors++;
  } else {
    row.slicePath = r.preparedPath;
    sliced++;
  }
}
console.error(`[postslice] sliced ${sliced} / ${toSlice.length} (${sliceErrors} slice errors)`);

// Batch pYIN
const PYIN_SCRIPT = join(ENGINE_SPIKE, 'scripts/lib/pyin_pitch.py');
const PYIN_PY = [
  join(REPO, 'apps/models/services/sam-audio/.venv/bin/python'),
  join(REPO, 'apps/models/services/soulx-singer/.venv/bin/python'),
].find(existsSync);
if (!PYIN_PY) {
  console.error('[postslice] no librosa venv found');
  process.exit(2);
}

const sliceWith = toSlice.filter((r) => r.slicePath);
const CHUNK = 50;
const pyinByPath = new Map();
for (let i = 0; i < sliceWith.length; i += CHUNK) {
  const slice = sliceWith.slice(i, i + CHUNK).map((r) => r.slicePath);
  process.stderr.write(`  chunk ${Math.floor(i / CHUNK) + 1}/${Math.ceil(sliceWith.length / CHUNK)} (${slice.length} files)... `);
  const r = spawnSync(PYIN_PY, [PYIN_SCRIPT, ...slice], { maxBuffer: 1024 * 1024 * 64 });
  if (r.status !== 0) {
    process.stderr.write(`FAILED\n${r.stderr?.toString() ?? ''}\n`);
    continue;
  }
  let parsed = 0;
  for (const line of r.stdout.toString().split('\n')) {
    if (!line.trim()) continue;
    try { const j = JSON.parse(line); pyinByPath.set(j.path, j); parsed++; } catch {}
  }
  process.stderr.write(`${parsed} results\n`);
}

// Compose output
const byCatalogId = {};
const byLowLevel = {};
let classified = 0, skipped = 0;
for (const row of rows) {
  if (row.skipReason) {
    byCatalogId[row.id] = {
      family: row.family, lowLevel: row.lowLevel, library: row.library,
      preset: row.preset, matchedPath: row.matchedPath,
      adjustment: 0, adjustmentReliable: false, skipReason: row.skipReason,
    };
    skipped++;
    continue;
  }
  if (row.sliceError) {
    byCatalogId[row.id] = {
      family: row.family, lowLevel: row.lowLevel, library: row.library,
      preset: row.preset, matchedPath: row.matchedPath,
      adjustment: 0, adjustmentReliable: false,
      skipReason: `slice-error: ${row.sliceError}`,
    };
    skipped++;
    continue;
  }
  const p = pyinByPath.get(row.slicePath);
  if (!p || p.error || p.f0Hz == null) {
    byCatalogId[row.id] = {
      family: row.family, lowLevel: row.lowLevel, library: row.library,
      preset: row.preset, matchedPath: row.matchedPath,
      slotNote: row.slotNote, expectedHz: row.expectedHz,
      adjustment: 0, adjustmentReliable: false,
      skipReason: p?.error ? `pyin-error: ${p.error}` : 'pyin-unvoiced',
    };
    skipped++;
    continue;
  }
  const detectedHz = p.f0Hz;
  const ratioOctaves = Number(Math.log2(detectedHz / row.expectedHz).toFixed(3));
  const adj = classifyByOctaveRatio(detectedHz, row.expectedHz);
  const adjustment = adj ?? 0;
  byCatalogId[row.id] = {
    family: row.family, lowLevel: row.lowLevel, library: row.library,
    preset: row.preset, matchedPath: row.matchedPath,
    slotNote: row.slotNote, slotType: row.slotType,
    sliceStart: row.sliceStart, sliceEnd: row.sliceEnd,
    expectedHz: Number(row.expectedHz.toFixed(2)),
    detectedHz: Number(detectedHz.toFixed(2)),
    ratioOctaves,
    voicedFraction: p.voicedFraction,
    adjustment,
    adjustmentReliable: adj != null,
  };
  classified++;
  const bk = (byLowLevel[row.lowLevel] ??= { count: 0, adjDistribution: {} });
  bk.count++;
  bk.adjDistribution[adjustment] = (bk.adjDistribution[adjustment] ?? 0) + 1;
}

mkdirSync(dirname(outPath), { recursive: true });
const out = {
  schemaVersion: 1,
  generatedFrom: {
    method: 'post-slice c3 slot pYIN — legacy-faithful',
    catalogContentHash: CATALOG.contentHash,
    auditContentHash: AUDIT.contentHash,
    sampleLibraryRoot: SAMPLE_LIB,
  },
  summary: { totalTonalRows: tonalRows.length, classified, skipped },
  byCatalogId,
  summaryByLowLevel: byLowLevel,
};
writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);

console.error(`[postslice] ${classified}/${tonalRows.length} classified, ${skipped} skipped`);
console.error(`[postslice] wrote ${outPath}`);
console.error('per-lowLevel summary:');
for (const [ll, info] of Object.entries(byLowLevel).sort()) {
  const dist = Object.entries(info.adjDistribution)
    .sort(([a], [b]) => Number.parseInt(a) - Number.parseInt(b))
    .map(([adj, n]) => `${adj >= 0 ? '+' : ''}${adj}×${n}`)
    .join(', ');
  console.error(`  ${ll.padEnd(40)} n=${String(info.count).padStart(3)}  [${dist}]`);
}
