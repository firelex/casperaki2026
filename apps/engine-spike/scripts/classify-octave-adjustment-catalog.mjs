#!/usr/bin/env node
// docs/58b — per-catalog-row octave-adjustment classifier.
//
// Mirrors the legacy `casperaki1/calculateOctaveAdjustmentsAndSaveToDatabase.js`
// but iterates the new brain catalog instead of a Postgres query:
//
//   for each tonal catalog row:
//     resolve its canonical disk recording via the sample-library audit
//     run librosa.pyin (= sonic-annotator vamp:pyin:yin:f0)
//     compare detected F0 to C3 (130.81 Hz) → octaveAdjustment per the
//       legacy log2-ratio with ±0.25-octave tolerance
//
// The legacy script ran on each instrument's C3 multisample slot; the
// equivalent here is the catalog row's canonical preset MP3, since
// staging stamps the same canonical bytes into every multisample slot
// (`stage-tonal.mjs:174-175`) and the engine sampler does the pitch
// mapping. So the single canonical recording IS the C3-slot bytes.
//
// Output:
//
//   apps/engine-spike/out/octave-adjustment-per-row.json
//
//   {
//     schemaVersion: 1,
//     generatedFrom: { catalogContentHash, auditContentHash },
//     summary: { totalTonalRows, classified, skipped },
//     byCatalogId: { "<id>": { family, lowLevel, library, preset,
//                              matchedPath, detectedHz, ratioOctaves,
//                              adjustment, voicedFraction } },
//     summaryByLowLevel: { "<lowLevel>": { count, adjDistribution } }
//   }
//
// Usage:
//   node scripts/classify-octave-adjustment-catalog.mjs [--out <path>] [--limit <N>]
//
// Requires CASPERAKI_SAMPLE_LIBRARY_ROOT in apps/engine-spike/.env.

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
if (!SAMPLE_LIB) {
  console.error('CASPERAKI_SAMPLE_LIBRARY_ROOT not set (expected in apps/engine-spike/.env)');
  process.exit(2);
}
if (!existsSync(SAMPLE_LIB)) {
  console.error(`Sample library root not found on disk: ${SAMPLE_LIB}`);
  process.exit(2);
}

// CLI
const args = process.argv.slice(2);
let outPath = join(ENGINE_SPIKE, 'out', 'octave-adjustment-per-row.json');
let limit = Infinity;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out' && i + 1 < args.length) outPath = resolve(args[++i]);
  else if (args[i] === '--limit' && i + 1 < args.length) limit = Number.parseInt(args[++i], 10);
}

// Load catalog + audit
const CATALOG = JSON.parse(readFileSync(
  join(REPO, 'packages/arrangement/data/instrument-catalog.snapshot.json'), 'utf-8'));
const AUDIT = JSON.parse(readFileSync(
  join(REPO, 'packages/arrangement/data/sample-library.audit.json'), 'utf-8'));

const matchedById = new Map(AUDIT.matched.map((m) => [m.catalogId, m]));

const TONAL_FAMILIES = new Set([
  'basses', 'keys', 'synths', 'leadSynths',
  'acousticGuitars', 'electricGuitars',
  'popBrass', 'popStrings', 'orchestral', 'vocals',
]);
const C3_HZ = 440 * Math.pow(2, (48 - 69) / 12); // 130.8128 Hz

// Same tolerance as the per-render classifier — see docs/58b.
const RATIO_TOLERANCE_OCTAVES = 0.25;
function classifyByOctaveRatio(detectedHz, expectedHz) {
  if (!detectedHz || detectedHz <= 0 || !expectedHz || expectedHz <= 0) return null;
  const octaves = Math.log2(detectedHz / expectedHz);
  const rounded = Math.round(octaves);
  if (Math.abs(octaves - rounded) > RATIO_TOLERANCE_OCTAVES) return null;
  // Sign convention: peak above expected → sample is too high → engine
  // compensates DOWN → adjustment = -rounded.
  const adj = -rounded;
  return Math.abs(adj) > 4 ? null : adj;
}

// Build the row work-list
const tonalRows = CATALOG.entries.filter((e) => TONAL_FAMILIES.has(e.family));
const rows = [];
let cap = 0;
for (const e of tonalRows) {
  if (cap >= limit) break;
  const m = matchedById.get(e.id);
  if (!m) {
    rows.push({
      id: e.id, family: e.family, lowLevel: e.lowLevel,
      library: e.library, preset: e.preset,
      skipReason: 'no-disk-match',
    });
    continue;
  }
  const fullPath = join(SAMPLE_LIB, m.matchedPath);
  if (!existsSync(fullPath)) {
    rows.push({
      id: e.id, family: e.family, lowLevel: e.lowLevel,
      library: e.library, preset: e.preset, matchedPath: m.matchedPath,
      skipReason: 'disk-file-missing',
    });
    continue;
  }
  rows.push({
    id: e.id, family: e.family, lowLevel: e.lowLevel,
    library: e.library, preset: e.preset, matchedPath: m.matchedPath,
    fullPath,
  });
  cap++;
}

const toRun = rows.filter((r) => r.fullPath && !r.skipReason);
console.error(`[classify-octave-catalog] ${tonalRows.length} tonal rows, ${toRun.length} ready to pYIN, ${rows.length - toRun.length} skipped`);

// pYIN — batch via the same Python helper used by the per-render classifier
const PYIN_SCRIPT = join(ENGINE_SPIKE, 'scripts/lib/pyin_pitch.py');
const PYIN_PY = [
  join(REPO, 'apps/models/services/sam-audio/.venv/bin/python'),
  join(REPO, 'apps/models/services/soulx-singer/.venv/bin/python'),
].find(existsSync);
if (!PYIN_PY) {
  console.error('[classify-octave-catalog] no librosa venv found (sam-audio/soulx-singer)');
  process.exit(2);
}
console.error(`[classify-octave-catalog] python: ${PYIN_PY}`);

// Chunk so a single subprocess doesn't sit on hundreds of files holding
// librosa state. 50 paths per chunk is a fair balance between Python
// startup amortisation and memory pressure.
const CHUNK = 50;
const pyinByPath = new Map();
for (let i = 0; i < toRun.length; i += CHUNK) {
  const slice = toRun.slice(i, i + CHUNK).map((r) => r.fullPath);
  process.stderr.write(`  chunk ${i / CHUNK + 1}/${Math.ceil(toRun.length / CHUNK)} (${slice.length} files)... `);
  const r = spawnSync(PYIN_PY, [PYIN_SCRIPT, ...slice], { maxBuffer: 1024 * 1024 * 64 });
  if (r.status !== 0) {
    process.stderr.write(`FAILED\n${r.stderr?.toString() ?? ''}\n`);
    continue;
  }
  let parsed = 0;
  for (const line of r.stdout.toString().split('\n')) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      pyinByPath.set(j.path, j);
      parsed++;
    } catch { /* ignore */ }
  }
  process.stderr.write(`${parsed} results\n`);
}

// Combine
const byCatalogId = {};
const byLowLevel = {};
let classified = 0, skipped = 0;
for (const row of rows) {
  if (row.skipReason) {
    byCatalogId[row.id] = { ...row, adjustment: 0, adjustmentReliable: false };
    skipped++;
    continue;
  }
  const p = pyinByPath.get(row.fullPath);
  if (!p) {
    byCatalogId[row.id] = { ...row, adjustment: 0, adjustmentReliable: false, skipReason: 'pyin-no-result' };
    skipped++;
    continue;
  }
  if (p.error) {
    byCatalogId[row.id] = { ...row, adjustment: 0, adjustmentReliable: false, skipReason: `pyin-error: ${p.error}` };
    skipped++;
    continue;
  }
  if (p.f0Hz == null) {
    byCatalogId[row.id] = { ...row, adjustment: 0, adjustmentReliable: false, skipReason: 'pyin-unvoiced' };
    skipped++;
    continue;
  }
  const detectedHz = p.f0Hz;
  const ratioOctaves = Number(Math.log2(detectedHz / C3_HZ).toFixed(3));
  const adj = classifyByOctaveRatio(detectedHz, C3_HZ);
  // Legacy behaviour: 'Unknown' → 0.
  const adjustment = adj ?? 0;
  const adjusted = adj != null;
  byCatalogId[row.id] = {
    family: row.family,
    lowLevel: row.lowLevel,
    library: row.library,
    preset: row.preset,
    matchedPath: row.matchedPath,
    detectedHz: Number(detectedHz.toFixed(2)),
    expectedHz: Number(C3_HZ.toFixed(2)),
    ratioOctaves,
    voicedFraction: p.voicedFraction,
    adjustment,
    adjustmentReliable: adjusted,
  };
  classified++;

  const bucket = (byLowLevel[row.lowLevel] ??= { count: 0, adjDistribution: {} });
  bucket.count++;
  bucket.adjDistribution[adjustment] = (bucket.adjDistribution[adjustment] ?? 0) + 1;
}

mkdirSync(dirname(outPath), { recursive: true });
const out = {
  schemaVersion: 1,
  generatedFrom: {
    catalogContentHash: CATALOG.contentHash,
    auditContentHash: AUDIT.contentHash,
    sampleLibraryRoot: SAMPLE_LIB,
  },
  summary: { totalTonalRows: tonalRows.length, classified, skipped },
  byCatalogId,
  summaryByLowLevel: byLowLevel,
};
writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);

console.error(`[classify-octave-catalog] ${classified}/${tonalRows.length} classified, ${skipped} skipped`);
console.error(`[classify-octave-catalog] wrote ${outPath}`);
console.error('');
console.error('per-lowLevel summary:');
const llEntries = Object.entries(byLowLevel).sort(([a], [b]) => a.localeCompare(b));
for (const [ll, info] of llEntries) {
  const dist = Object.entries(info.adjDistribution)
    .sort(([a], [b]) => Number.parseInt(a) - Number.parseInt(b))
    .map(([adj, n]) => `${adj >= 0 ? '+' : ''}${adj}×${n}`)
    .join(', ');
  console.error(`  ${ll.padEnd(40)} n=${String(info.count).padStart(3)}  [${dist}]`);
}
