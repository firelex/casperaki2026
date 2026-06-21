#!/usr/bin/env node
// Phase 2 spike — emit the legacy-engine envelope to disk from a canonical
// Song, going through @casperaki/song-schema's toEngineEnvelope adapter.
//
// Usage:
//   node emit-engine-envelope.mjs <fixture-id> <out-dir>
// Defaults: fixture-id=engine-web-tester-1, out-dir=../out/web-tester-1
//
// Reads the same web-tester fixture that lives in the schema package's test
// corpus, runs it through fromEngineEnvelope (which normalizes legacy
// tempo/structure → canonical bpm/songStructure) and then toEngineEnvelope
// (which emits the engine-readable bytes — tempo + structure + segment-keyed
// arrangement). The C++ harness loads those files verbatim.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fromEngineEnvelope,
  toEngineEnvelope,
} from '@casperaki/song-schema';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = resolve(
  __dirname,
  '../../../packages/song-schema/test/fixtures',
);

const fixtureId = process.argv[2] ?? 'engine-web-tester-1';
const outDir = resolve(
  __dirname,
  process.argv[3] ?? `../out/${fixtureId}`,
);

function loadWebTester() {
  const dir = join(FIXTURES_ROOT, 'engine-web-tester-1');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'meta.json');
  const song = JSON.parse(readFileSync(join(dir, 'song.json'), 'utf-8'));
  const instruments = files
    .filter((f) => f.startsWith('inst-'))
    .sort((a, b) => Number(a.match(/\d+/)?.[0] ?? 0) - Number(b.match(/\d+/)?.[0] ?? 0))
    .map((f) => ({ file: f, json: JSON.parse(readFileSync(join(dir, f), 'utf-8')) }));
  return { song, instruments };
}

if (fixtureId !== 'engine-web-tester-1') {
  throw new Error(`only web-tester fixture wired for the spike (got ${fixtureId})`);
}

const raw = loadWebTester();

const canonical = fromEngineEnvelope({
  song: raw.song,
  instruments: raw.instruments.map((i) => i.json),
});

console.error(`[emit] canonical diagnostics:`);
for (const d of canonical.diagnostics) {
  console.error(`  ${d.severity.padEnd(7)} ${d.path}: ${d.message} [${d.action}]`);
}

const envelope = toEngineEnvelope(canonical.song);

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'song.json'), JSON.stringify(envelope.song, null, 2));
for (let i = 0; i < envelope.instruments.length; i++) {
  writeFileSync(
    join(outDir, `inst-${i + 1}.json`),
    JSON.stringify(envelope.instruments[i], null, 2),
  );
}

const songKeys = Object.keys(envelope.song);
console.error(`[emit] wrote ${outDir}`);
console.error(`[emit] song.json top-level keys: ${songKeys.sort().join(', ')}`);
console.error(`[emit] instrument count: ${envelope.instruments.length}`);
console.error(`[emit] tempo present: ${songKeys.includes('tempo')}`);
console.error(`[emit] structure present: ${songKeys.includes('structure')}`);
console.error(
  `[emit] absent (good): bpm=${!songKeys.includes('bpm')} songStructure=${!songKeys.includes('songStructure')}`,
);
