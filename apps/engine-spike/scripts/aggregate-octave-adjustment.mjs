#!/usr/bin/env node
// docs/58b — Aggregate per-render octave-adjustment-map.json files
// (one per genre) into a single per-`lowLevelType` table for 58c to
// consume.
//
// Each genre render carries a specific catalog row per family; merging
// across genres gives us coverage of however many distinct catalog rows
// participated in the 8-genre matrix. We key the final map on
// `(lowLevelType, catalogId)` — catalogId is the brain's stable id for
// the specific row — so 58c's adapter wiring can look up by either.
//
// Output shape:
//
//   {
//     "schemaVersion": 1,
//     "byCatalogId": {
//       "<catalogId>": { lowLevelType, instName, adjustment, source: [...] }
//     },
//     "byLowLevelType": {
//       "<lowLevelType>": { adjustment, agree: true|false, samples: [...] }
//     }
//   }
//
// `byLowLevelType.<X>.agree=false` flags a lowLevel for which different
// catalog rows disagreed on the adjustment — investigation needed
// before 58c can use the value as a default.

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('usage: aggregate-octave-adjustment.mjs <out.json> <renderDir...>');
  process.exit(2);
}
const outPath = resolve(args[0]);
const renderDirs = args.slice(1).map((p) => resolve(p));

const byCatalogId = {};
const byLowLevelByAdj = {}; // lowLevelType → adjustment → Set of (catalogId|null)

for (const rd of renderDirs) {
  const mapPath = join(rd, 'octave-adjustment-map.json');
  if (!existsSync(mapPath)) {
    console.error(`[aggregate-octave] skip ${rd} — no octave-adjustment-map.json`);
    continue;
  }
  const m = JSON.parse(readFileSync(mapPath, 'utf-8'));
  for (const [file, entry] of Object.entries(m.entries ?? {})) {
    if (entry.adjustment === undefined) continue; // skipped
    const llt = entry.lowLevelType ?? '(unknown-lowLevelType)';
    const catId = entry.catalogId ?? null;
    const adj = entry.adjustment;

    if (catId != null) {
      const cur = byCatalogId[catId];
      if (!cur) {
        byCatalogId[catId] = {
          lowLevelType: llt,
          instName: entry.name,
          adjustment: adj,
          sources: [{ renderDir: rd, file, detectedHz: entry.detectedHz, detector: entry.detector }],
          conflicting: false,
        };
      } else {
        cur.sources.push({ renderDir: rd, file, detectedHz: entry.detectedHz, detector: entry.detector });
        if (cur.adjustment !== adj) cur.conflicting = true;
      }
    }

    const byAdj = (byLowLevelByAdj[llt] ??= {});
    const set = (byAdj[adj] ??= new Set());
    set.add(catId ?? `${entry.name}|${entry.slotId}`);
  }
}

const byLowLevelType = {};
for (const [llt, byAdj] of Object.entries(byLowLevelByAdj)) {
  const adjEntries = Object.entries(byAdj).map(([adj, set]) => ({
    adjustment: Number.parseInt(adj, 10),
    count: set.size,
    samples: [...set],
  }));
  adjEntries.sort((a, b) => b.count - a.count);
  byLowLevelType[llt] = {
    adjustment: adjEntries[0]?.adjustment ?? 0,
    agree: adjEntries.length === 1,
    distribution: adjEntries,
  };
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify({
  schemaVersion: 1,
  generatedFrom: renderDirs,
  byCatalogId,
  byLowLevelType,
}, null, 2)}\n`);

console.error(`[aggregate-octave] wrote ${outPath}`);
console.error(`  ${Object.keys(byCatalogId).length} unique catalogIds, ${Object.keys(byLowLevelType).length} lowLevelTypes`);
for (const [llt, info] of Object.entries(byLowLevelType).sort()) {
  const tag = info.agree ? 'agree' : `DISAGREE: ${info.distribution.map((d) => `${d.adjustment}×${d.count}`).join(', ')}`;
  console.error(`  ${llt.padEnd(38)} adj=${info.adjustment >= 0 ? '+' : ''}${info.adjustment}  ${tag}`);
}
