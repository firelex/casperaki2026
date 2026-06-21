#!/usr/bin/env node
// docs/58e — Probe how many of the legacy effectsMetadata.json fx
// entries (2,979 total; ~2,934 not yet in the xlsx catalog) can be
// resolved to a real disk file under CASPERAKI_SAMPLE_LIBRARY_ROOT.
//
// This is a READ-ONLY survey. No catalog write, no overlay file. Just
// a coverage report so we know whether the merger can deterministically
// produce disk paths for the missing entries before we commit to
// building it.
//
// Strategy:
//   1. Walk the sample library once, build an index keyed by
//      lower-cased basename stem (extension stripped, spaces &
//      dashes & underscores collapsed). Each stem maps to a list of
//      disk paths (variants of the same source asset).
//   2. For each legacy entry, parse its filename into a candidate
//      stem. Try the stem against the index; on miss, retry with
//      common transformations (drop "Big_Z_" prefix → "Uplifter_4";
//      try without trailing modifiers like "- 124").
//   3. Tally matches per legacy subtype + report fail modes.
//
// Usage:
//   node scripts/probe-legacy-fx-disk.mjs [--limit N] [--out <path>]

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENGINE_SPIKE = resolve(__dirname, '..');
const REPO = resolve(ENGINE_SPIKE, '../..');
if (existsSync(join(ENGINE_SPIKE, '.env')) && process.loadEnvFile) {
  process.loadEnvFile(join(ENGINE_SPIKE, '.env'));
}
const SAMPLE_LIB = process.env.CASPERAKI_SAMPLE_LIBRARY_ROOT;
if (!SAMPLE_LIB || !existsSync(SAMPLE_LIB)) {
  console.error(`CASPERAKI_SAMPLE_LIBRARY_ROOT missing or unreadable`);
  process.exit(2);
}

const args = process.argv.slice(2);
let limit = Infinity;
let outPath = join(ENGINE_SPIKE, 'out', 'legacy-fx-disk-match.json');
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--limit' && i + 1 < args.length) limit = Number.parseInt(args[++i], 10);
  else if (args[i] === '--out' && i + 1 < args.length) outPath = resolve(args[++i]);
}

// Where on disk to scan. Legacy edmFills/edmBuildups got reclassified
// to percussionBreaks. Other fx subtypes live under fx/.
const SCAN_ROOTS = [
  join(SAMPLE_LIB, 'fx'),
  join(SAMPLE_LIB, 'percussionBreaks'),
  // Drum rolls / one-shot impacts can land under cymbals + shakers too;
  // legacy `crash` subtype maps to cymbals.cymbalsCrashHit.
  join(SAMPLE_LIB, 'cymbals'),
];

const LEGACY = JSON.parse(readFileSync(
  join(REPO, 'packages/arrangement/data/legacy/effects-metadata.json'), 'utf-8'));

// ---- Build disk index ----
console.error('[probe] indexing disk...');
const t0 = Date.now();
const byStem = new Map(); // stem → [{path, rel, ext, size, dirStem}]
let filesIndexed = 0;
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'flac', 'aif', 'aiff']);

function normaliseStem(s) {
  let out = s.toLowerCase();
  out = out.replace(/^-\s*/u, '');
  out = out.replace(/[\s_\-]+/gu, '_');
  out = out.replace(/_modified(_extended)?$/u, '');
  return out;
}

function walk(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!e.isFile()) continue;
    const dot = e.name.lastIndexOf('.');
    if (dot <= 0) continue;
    const ext = e.name.slice(dot + 1).toLowerCase();
    if (!AUDIO_EXTS.has(ext)) continue;
    const base = e.name.slice(0, dot);
    const stem = normaliseStem(base);
    // Disk paths often look like "fx - fxX - <style> - <library> - <preset>.mp3"
    // Extract the trailing preset chunk for a secondary index.
    const dashed = base.split(' - ');
    const presetStem = dashed.length >= 1 ? normaliseStem(dashed[dashed.length - 1]) : stem;
    const recs = byStem.get(stem) ?? [];
    recs.push({ path: p, rel: p.slice(SAMPLE_LIB.length + 1), ext, presetStem });
    byStem.set(stem, recs);
    // Secondary key: just the trailing-preset stem (when it differs)
    if (presetStem !== stem) {
      const recs2 = byStem.get(presetStem) ?? [];
      recs2.push({ path: p, rel: p.slice(SAMPLE_LIB.length + 1), ext, presetStem });
      byStem.set(presetStem, recs2);
    }
    filesIndexed++;
  }
}

for (const root of SCAN_ROOTS) {
  if (existsSync(root)) walk(root);
}
console.error(`[probe] indexed ${filesIndexed} files in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
console.error(`[probe] distinct stems: ${byStem.size}`);

// ---- Legacy filename parser ----
// Legacy names look like "Big_Z_Uplifter_4.wav" or "Serum FX 16-bar riser 1.wav"
// or "Type1_A.wav" or "BANK_00_INSTR_000A_SND_0001.wav" or "VEH1 Reverse - 19.wav".
// Library-prefix table. Each entry's `prefix` is the legacy-side library
// stem (lower-cased, separators preserved) that legacy filenames lead
// with. The `lib` value is the catalog `library` field we'd write.
//
// CRITICAL: only strip the LIBRARY name. Pack/sub-bank tokens that follow
// (UFBT, FX, VEH3, etc.) stay as part of the preset stem because the
// disk filename `<library> - <preset>.mp3` has them in the preset half.
const LIB_PREFIXES = [
  ['big_z',       'bigZ'],
  ['big z',       'bigZ'],
  ['oversampled', 'oversampled'],
  ['serum',       'serum'],
  ['bank_',       '8bit'],
  ['slp',         'sampleMagic'],
  ['flp',         'sampleMagic'],
  // Vengeance VEH packs ship as filenames `VEH1 Reverse - 19.wav` etc.;
  // the VEH<N> is part of the preset on disk (`vengeance - VEH1 Reverse - 19.mp3`)
  // so DON'T strip it — leave the lib field nullable and match by preset.
];

function parseLegacy(fname) {
  // Trim trailing whitespace inside the basename — one legacy entry has
  // a stray space before the extension ("UFBT_build_loop_45_130bpm .wav").
  let stem = fname.replace(/\s+\.([^.]+)$/u, '.$1').replace(/\.[^.]+$/u, '');
  stem = stem.replace(/^-\s*/u, '').trim();
  // Legacy `Big_Z_Crash_<N>_reverse` lives on disk as `bigZ - ReverseCrash_<N>`
  // in `cymbals/cymbalsReverse/`. Rewrite the preset half so the
  // canonical-stem index can find it.
  stem = stem.replace(/^Big_Z_Crash_(\d+)_reverse$/u, 'Big_Z_ReverseCrash_$1');
  const lower = stem.toLowerCase().replace(/^\s*-\s*/u, '');
  for (const [prefix, lib] of LIB_PREFIXES) {
    if (lower.startsWith(prefix)) {
      const remainder = stem.slice(prefix.length).replace(/^[\s_\-]+/u, '');
      return { lib, preset: remainder, stem: normaliseStem(stem), presetStem: normaliseStem(remainder) };
    }
  }
  return { lib: null, preset: stem, stem: normaliseStem(stem), presetStem: normaliseStem(stem) };
}

// ---- Match each legacy entry ----
let scanned = 0;
const byOutcome = new Map(); // outcome → [{ subtype, fname }]
const bySubtypeOutcome = new Map(); // subtype → outcome → count
const matches = []; // [{ subtype, fname, lib, preset, diskPath, kind }]

for (const [subtype, items] of Object.entries(LEGACY)) {
  for (const it of items) {
    if (scanned >= limit) break;
    const fname = it.fx;
    if (!fname) continue;
    const parsed = parseLegacy(fname);

    // Try in order: full stem, preset stem
    let hits = byStem.get(parsed.stem) ?? [];
    let kind = 'stem';
    if (hits.length === 0 && parsed.presetStem) {
      hits = byStem.get(parsed.presetStem) ?? [];
      kind = 'preset-stem';
    }
    // Loose retry: try with last "_N" stripped (for "Foo - 123" indices)
    if (hits.length === 0) {
      const looser = parsed.stem.replace(/_\d+$/u, '');
      hits = byStem.get(looser) ?? [];
      if (hits.length) kind = 'stripped-trailing-index';
    }

    let outcome;
    if (hits.length === 0) outcome = 'no-match';
    else if (hits.length === 1) outcome = 'unique';
    else outcome = 'multi';

    byOutcome.set(outcome, (byOutcome.get(outcome) ?? 0) + 1);
    if (!bySubtypeOutcome.has(subtype)) bySubtypeOutcome.set(subtype, {});
    const so = bySubtypeOutcome.get(subtype);
    so[outcome] = (so[outcome] ?? 0) + 1;

    if (outcome === 'unique') {
      matches.push({ subtype, fname, lib: parsed.lib, preset: parsed.preset, diskPath: hits[0].rel, kind });
    }

    scanned++;
  }
}

// ---- Report ----
console.error('');
console.error(`[probe] scanned ${scanned} legacy entries`);
console.error('[probe] outcomes:');
for (const [k, n] of [...byOutcome.entries()].sort((a, b) => b[1] - a[1])) {
  console.error(`    ${k}: ${n}`);
}
console.error('');
console.error('[probe] by subtype:');
const subtypes = [...bySubtypeOutcome.keys()].sort();
for (const sub of subtypes) {
  const so = bySubtypeOutcome.get(sub);
  const total = Object.values(so).reduce((a, b) => a + b, 0);
  const unique = so.unique ?? 0;
  const multi = so.multi ?? 0;
  const none = so['no-match'] ?? 0;
  console.error(`  ${sub.padEnd(16)} total=${String(total).padStart(5)}  unique=${String(unique).padStart(5)}  multi=${String(multi).padStart(4)}  no-match=${String(none).padStart(5)}`);
}

// ---- Persist ----
mkdirSync(dirname(outPath), { recursive: true });
const out = {
  schemaVersion: 1,
  generatedAt: 'static — set externally',
  scanned,
  outcomes: Object.fromEntries(byOutcome),
  bySubtype: Object.fromEntries(bySubtypeOutcome),
  matchesSample: matches.slice(0, 30),
};
writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
console.error('');
console.error(`[probe] wrote ${outPath}`);
