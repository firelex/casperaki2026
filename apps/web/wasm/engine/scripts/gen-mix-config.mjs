#!/usr/bin/env node
// Generate the shared mix/FX config JSON (the single source of truth for
// per-lane volumes, fxGroup routing, aux-send levels, master/transition trims,
// and the AirWindows rack chains) consumed at runtime by BOTH engines.
//
// Source of truth for GENERATION: the WASM engine's MixTables.h + RackData.h.
// These are verified field-for-field identical to native FX.h / Sequencer.cpp /
// (decoded) PresetManager.h — see docs — but are regular, de-duped C++ data
// (MixTables.h already drops the native FX.h:634 duplicate) and the rack params
// are already decoded floats, so parsing them is robust where parsing the native
// base64 VST state / if-chains is fragile. The values are byte-identical to what
// the WASM engine currently compiles in, so loading this JSON reproduces the
// current renders exactly (the parity gate).
//
// Output: casperaki_engine/config/mix-config.json  (lives in the native repo;
// both engines load it at runtime).
//
// Usage: node scripts/gen-mix-config.mjs [outPath]

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENGINE_SRC = resolve(__dirname, '../src/audio');
const MIXTABLES = resolve(ENGINE_SRC, 'MixTables.h');
const RACKDATA = resolve(ENGINE_SRC, 'RackData.h');
const OUT = process.argv[2]
  ? resolve(process.cwd(), process.argv[2])
  : resolve(__dirname, '../../../../../../casperaki_engine/config/mix-config.json');

const mix = readFileSync(MIXTABLES, 'utf-8');
const rack = readFileSync(RACKDATA, 'utf-8');

// --- helper: slice a function/table body by name -------------------------------
function bodyAfter(src, anchor) {
  const i = src.indexOf(anchor);
  if (i < 0) throw new Error(`anchor not found: ${anchor}`);
  return src.slice(i);
}

// --- typeToFxGroup: parse the getFxGroup() static table {"X","Y"} --------------
function parseTypeToFxGroup() {
  const seg = bodyAfter(mix, 'getFxGroup(').split('static const std::string kDrums')[0];
  const out = {};
  for (const m of seg.matchAll(/\{\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\}/g)) out[m[1]] = m[2];
  return out;
}

// --- instrumentFxSends: fxGroup -> {reverb,delay,chorus} -----------------------
function parseInstrumentFxSends() {
  const seg = bodyAfter(mix, 'instrumentFxSends(').split('auto it = table.find')[0];
  const out = {};
  for (const m of seg.matchAll(/\{\s*"([^"]+)"\s*,\s*\{\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*\}\s*\}/g)) {
    out[m[1]] = { reverb: +m[2], delay: +m[3], chorus: +m[4] };
  }
  return out;
}

// --- instrumentTargetVolume: ordered rules from the getInstrumentTargetVolume
//     if-chain. Each: { type, genres?: [...], db }. First match wins at runtime;
//     no match -> 0 (the function's trailing `return 0`). -----------------------
function parseTargetVolume() {
  const seg = bodyAfter(mix, 'getInstrumentTargetVolume(const std::string& t')
    .split('\n}')[0];
  const rules = [];
  // Value can be a literal or a simple expression, e.g. `return 0 - 3;` (= -3).
  const re = /if\s*\(\s*t\s*==\s*"([^"]+)"\s*(?:&&\s*(.+?))?\)\s*return\s*([^;]+?)\s*;/g;
  const evalDb = (expr) => {
    const m = expr.trim().match(/^(-?\d+(?:\.\d+)?)\s*(?:([-+])\s*(\d+(?:\.\d+)?))?$/);
    if (!m) throw new Error(`unparseable target-volume value: "${expr}"`);
    let v = +m[1];
    if (m[2]) v = m[2] === '-' ? v - +m[3] : v + +m[3];
    return v;
  };
  for (const m of seg.matchAll(re)) {
    const rule = { type: m[1] };
    if (m[2]) {
      const genres = [...m[2].matchAll(/g\s*==\s*"([^"]+)"/g)].map((x) => x[1]);
      if (genres.length) rule.genres = genres;
    }
    rule.db = evalDb(m[3]);
    rules.push(rule);
  }
  return rules;
}

// --- laneSendOverrides: the laneSendsDb() per-type / per-group-genre overrides
//     applied ON TOP of instrumentFxSends. Mirrors MixTables.h:347-364 exactly.
//     `op:"add"` = relative (dB delta); `op:"set"` = absolute. Applied in order.
//     (Hand-encoded — the source is imperative C++, not a table — and guarded by
//     the render parity gate.) ---------------------------------------------------
function laneSendOverrides() {
  return {
    byType: [
      { types: ['acousticGuitarsNylonMono', 'acousticGuitarsNylonStereo',
                'acousticGuitarsSteelMono', 'acousticGuitarsSteelStereo'],
        op: 'add', reverb: -8, delay: -8, chorus: -8 },
      { types: ['synthsBrightPad', 'synthsSoftPad'], op: 'set', reverb: -14 },
      { types: ['synthsPlucked'], op: 'set', delay: -10 },
      { types: ['keysAcousticPiano'], op: 'set', reverb: -14, delay: -10 },
    ],
    // Applied after byType; keyed on fxGroup + genre.
    // EMPTY by design (docs/65): the legacy oracle's Sequencer.cpp drum-reverb
    // genre overrides (ballad -14 / rock -18) are DEAD CODE — `if (lowLevelType
    // == "drums")` catches the Drums instrument before the `else if (genre ==
    // ...)` branches ever run, and no standalone snareDrums regular instrument is
    // ever emitted (snares arrive only via the Drums instrument or transitions).
    // So the oracle renders drum reverb at the group base (-25) in every genre.
    // Encoding -14/-18 here made WASM (and the JSON-driven native) diverge ABOVE
    // the oracle; the reference is ~/apps/casperaki_engine, so we match it.
    byGroupGenre: [],
  };
}

// --- rackChains: parse RackData.h rackChains() ---------------------------------
function parseRackChains() {
  const seg = bodyAfter(rack, 'rackChains()');
  const chains = [];
  // Each bus: { "BUS", { <plugin>, <plugin>, ... } },
  const busRe = /\{\s*"([^"]+)"\s*,\s*\{([\s\S]*?)\}\s*\}\s*,\s*\n/g;
  // Plugin: { "factory", { p, p, ... } }
  const plugRe = /\{\s*"(make[A-Za-z0-9]+)"\s*,\s*\{([^}]*)\}\s*\}/g;
  for (const bm of seg.matchAll(busRe)) {
    const bus = bm[1];
    const plugins = [];
    for (const pm of bm[2].matchAll(plugRe)) {
      const params = [...pm[2].matchAll(/(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)f/gi)].map((x) => +x[1]);
      plugins.push({ factory: pm[1], params });
    }
    if (plugins.length) chains.push({ bus, plugins });
  }
  return chains;
}

// --- master volume constant ----------------------------------------------------
function parseMasterDb() {
  const m = mix.match(/kMasterVolumeDb\s*=\s*(-?\d+(?:\.\d+)?)/);
  return m ? +m[1] : -1.0;
}

const config = {
  version: 1,
  _comment: 'Shared mix/FX config — generated by gen-mix-config.mjs from the WASM '
    + 'MixTables.h + RackData.h (== native FX.h/Sequencer.cpp/PresetManager.h). '
    + 'Loaded at runtime by both engines. Edit values here to retune lanes.',
  constants: {
    masterVolumeDb: parseMasterDb(),
    transitionsTrimDb: -10.0,   // Sequencer.cpp:208 "Sample Transitions FX" track trim
    volScaleFactor: 20.0,        // Tracktion fader law + sampler velocity (gainDb-20*(1-vel))
  },
  typeToFxGroup: parseTypeToFxGroup(),
  instrumentTargetVolume: parseTargetVolume(),
  instrumentFxSends: parseInstrumentFxSends(),
  laneSendOverrides: laneSendOverrides(),
  rackChains: parseRackChains(),
};

// --- sanity counts -------------------------------------------------------------
const counts = {
  typeToFxGroup: Object.keys(config.typeToFxGroup).length,
  instrumentTargetVolume: config.instrumentTargetVolume.length,
  instrumentFxSends: Object.keys(config.instrumentFxSends).length,
  rackChains: config.rackChains.length,
};
console.error('[gen-mix-config] counts:', JSON.stringify(counts));
if (counts.typeToFxGroup < 120) throw new Error('typeToFxGroup parse looks short');
if (counts.instrumentTargetVolume < 150) throw new Error('targetVolume parse looks short');
if (counts.instrumentFxSends !== 14) throw new Error('instrumentFxSends expected 14');
if (counts.rackChains < 14) throw new Error('rackChains parse looks short');

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(config, null, 2) + '\n');
console.error(`[gen-mix-config] wrote ${OUT}`);
