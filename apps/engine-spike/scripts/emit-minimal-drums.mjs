#!/usr/bin/env node
// Phase 2 spike — emit a minimal Drums-only engine envelope.
//
// Pipeline: web-tester fixture → @casperaki/song-schema canonical →
// toEngineEnvelope → post-process to keep only Drums + intro + 3 drum ids,
// with explicit kick/snare/hat pattern grids. Writes to ../out/minimal-drums/.
//
// Bass needs the /vstSample/load/ ZIP-batch download path; that's a follow-up.
// This script proves the @casperaki/song-schema adapter + engine bytes against
// a setSong() the stub server can fully satisfy.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromEngineEnvelope, toEngineEnvelope } from '@casperaki/song-schema';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = resolve(__dirname, '../../../packages/song-schema/test/fixtures');
const outDir = resolve(__dirname, '../out/minimal-drums');

function loadJson(p) { return JSON.parse(readFileSync(p, 'utf-8')); }

const fixDir = join(FIXTURES_ROOT, 'engine-web-tester-1');
const rawSong = loadJson(join(fixDir, 'song.json'));
const rawInsts = readdirSync(fixDir)
  .filter((f) => f.startsWith('inst-') && f.endsWith('.json'))
  .sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]))
  .map((f) => loadJson(join(fixDir, f)));

const canonical = fromEngineEnvelope({ song: rawSong, instruments: rawInsts });
const envelope = toEngineEnvelope(canonical.song);

// --- post-process the engine envelope -----------------------------------

const song = envelope.song;

// Keep just the intro segment.
const intro = song.structure.find((s) => s.segment === 'intro');
if (!intro) throw new Error('intro segment missing from fixture');
song.structure = [intro];

// Keep only the Drums entry inside intro's arrangement payload.
const introArr = song.arrangement.intro;
if (!introArr) throw new Error('intro missing from arrangement');
for (const k of Object.keys(song.arrangement)) {
  if (k !== 'intro') delete song.arrangement[k];
}
for (const k of Object.keys(introArr.instruments ?? {})) {
  if (k !== 'Drums') delete introArr.instruments[k];
}
for (const k of Object.keys(introArr.overrides ?? {})) {
  if (k !== 'Drums') delete introArr.overrides[k];
}
introArr.mutes = {};
introArr.fills = {};
introArr.signalProcessors = {};
introArr.transitions = {};

// Explicit 4/4 drum pattern — kick on 1+3, snare on 2+4, hat on every 8th.
// 32-step strings == one bar. The 4-bar intro repeats this.
const oneBar = (chars) => chars; // tagged-template-like helper
introArr.overrides.Drums = {
  type: 'minimalProof',
  pattern: {
    bassDrum1:   oneBar('x000000000000000x000000000000000'),
    snareDrum1:  oneBar('00000000x0000000000000000x0000000'.slice(0, 32)),
    hiHatClosed1: oneBar('x000x000x000x000x000x000x000x000'),
  },
};

// --- trim inst-1 (Drums) to three ids ------------------------------------

const drumsInst = envelope.instruments[0];
if (drumsInst.name !== 'Drums') throw new Error('inst-1 is not Drums?');
// Drums constructor in casperaki_engine assumes the full kit's ids/sub-
// instruments are present (kicks/snares/toms/rest); trimming them crashes
// the engine. Keep the full kit — the stub server returns a fallback tone
// for the IDs not in the pattern override.

// Drop every other instrument; spike runs Drums only on the stub server.
envelope.instruments = [drumsInst];

// --- write ----------------------------------------------------------------

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'song.json'), JSON.stringify(song, null, 2));
writeFileSync(join(outDir, 'inst-1.json'), JSON.stringify(drumsInst, null, 2));

console.error(`[trim] wrote ${outDir}`);
console.error(`[trim] structure segments: ${song.structure.map((s) => s.segment).join(',')}`);
console.error(`[trim] arrangement segments: ${Object.keys(song.arrangement).join(',')}`);
console.error(`[trim] intro instruments: ${Object.keys(introArr.instruments).join(',')}`);
console.error(`[trim] drums ids: ${Object.keys(drumsInst.ids).join(',')}`);
console.error(`[trim] drum sample IDs to stage: ${Object.values(drumsInst.ids).join(',')}`);
