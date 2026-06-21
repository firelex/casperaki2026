#!/usr/bin/env node
// Extract the AirWindows rack chains from casperaki_engine PresetManager.h (the
// `#if JUCE_PLUGINHOST_VST` block — the canonical/golden AirWindows path) and emit
// a C++ data table (src/audio/RackData.h). For each rack (per fxGroup / aux return
// / master) it records the ordered plugin list + each plugin's decoded [0,1]
// params. Plugin order = <PLUGININSTANCE> document order = the rack's signal chain
// (x=0.2..0.8 left-to-right, matching the CONNECTION graph input->...->output).
//
//   node scripts/extract-rack-data.mjs [path/to/PresetManager.h]
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeParams, decodeJuceMemoryBlock } from '../tools/decode-airwindows-state.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRESET = process.argv[2] ?? '/home/roli79/apps/casperaki_engine/Source/PresetManager.h';
const OUT = resolve(__dirname, '../src/audio/RackData.h');

// PRESET_BALLAD_<X> -> the bus key the MixGraph routes by (fxGroup names match
// mix::getFxGroup; the three returns + master are special buses).
const BUS = {
  MASTER: 'master', FX_CHORUS: 'fxChorus', FX_PLATE_REVERB: 'fxPlateReverb',
  FX_STEREO_DELAY: 'fxStereoDelay', FX: 'fx', KICKS: 'kicks', DRUMS: 'drums',
  PERCUSSION: 'percussion', BASS: 'bass', KEYS: 'keys', SYNTHS: 'synths',
  LEAD_SYNTHS: 'leadSynths', ACOU_GUITARS: 'acousticGuitars',
  ELEC_GUITARS: 'electricGuitars', ORCHESTRAL: 'orchestral',
};

// Plugin name (state= chunk, after stripping a trailing "64"/"_x64") -> the C++
// factory in AwPlugins.h. Unmapped names are reported (and routed to passthrough).
const FACTORY = {
  Console8SubIn: 'makeConsole8SubIn', Console8SubOut: 'makeConsole8SubOut',
  Console8BussIn: 'makeConsole8BussIn', Console8BussOut: 'makeConsole8BussOut',
  Air2: 'makeAir2', Huge: 'makeHuge', StereoChorus: 'makeStereoChorus',
  TexturizeMS: 'makeTexturizeMS', kPlateA: 'makeKPlateA', kPlateD: 'makeKPlateD',
  Pyewacket: 'makePyewacket', EQ: 'makeEQ', Logical4: 'makeLogical4',
  'NC-17': 'makeNC17', NCSeventeen: 'makeNC17', Thunder: 'makeThunder',
  ADClip7: 'makeADClip7', SimpleSide: 'makeSimpleSide',
  // ValhallaFreqEcho (proprietary, no source) -> our from-scratch frequency-shift echo.
  ValhallaFreqEcho: "makeFreqShiftEcho", ValhallaFreqEcho_x: "makeFreqShiftEcho",
};

const normName = (n) => n.replace(/64$/, '').replace(/_x$/, '');

// SimpleSide state isn't AirWindows-float: it's 2 doubles (mix, rateValue) + curve
// points (x,y,rawExp floats). Decode into the flat [mix, rate, x,y,exp, ...] array
// SimpleSideImpl::setParam expects.
function decodeSimpleSide(state) {
  const buf = decodeJuceMemoryBlock(state);
  const body = buf.subarray(160);
  const out = [body.readDoubleLE(0), body.readDoubleLE(8)];
  for (let off = 16; off + 12 <= body.length; off += 12)
    out.push(body.readFloatLE(off), body.readFloatLE(off + 4), body.readFloatLE(off + 8));
  return out;
}

// FreqShiftEcho params for the delay aux RETURN — DECODED from the ValhallaFreqEcho
// state (it's FXB-wrapped XML, not opaque): [wetDryMix, shift, feedback, sync, lowCut,
// highCut]. Pulled straight from the preset so the reimplementation matches Valhalla.
function decodeValhalla(state) {
  const buf = decodeJuceMemoryBlock(state);
  const txt = buf.toString('latin1');
  const get = (k) => { const m = txt.match(new RegExp(`${k}="([-0-9.]+)"`)); return m ? Number(m[1]) : 0; };
  return [get('wetDryMix'), get('shift'), get('feedback'), get('sync'), get('lowCut'), get('highCut')];
}

const src = readFileSync(PRESET, 'utf-8');
const ifStart = src.indexOf('#if JUCE_PLUGINHOST_VST');
const elseAt = src.indexOf('#else', ifStart);
const block = src.slice(ifStart, elseAt);

const rackRe = /PRESET_BALLAD_(\w+)\s*=\s*R"\(([\s\S]*?)\)"/g;
const racks = [];
const unknownNames = new Set();
let m;
while ((m = rackRe.exec(block)) !== null) {
  const key = m[1], xml = m[2], bus = BUS[key];
  if (!bus) continue;
  const plugins = [];
  // Each <PLUGININSTANCE> wraps one <PLUGIN ... name="..." ... state="...">.
  for (const inst of xml.split('<PLUGININSTANCE').slice(1)) {
    const nm = inst.match(/\bname="([^"]+)"/);   // \b so it skips file*name*="..."
    const st = inst.match(/\bstate="([^"]+)"/);
    if (!nm || !st) continue;
    const name = normName(nm[1]);
    const factory = FACTORY[name];
    if (!factory) unknownNames.add(nm[1]);
    let params = [];
    if (name === 'SimpleSide') {
      params = decodeSimpleSide(st[1]);                 // 2 doubles + curve triples
    } else if (name === 'ValhallaFreqEcho') {
      params = decodeValhalla(st[1]);                   // decoded XML -> FreqShiftEcho params
    } else {
      try { params = decodeParams(st[1]).params; } catch { /* opaque */ }
    }
    plugins.push({ name, factory: factory ?? 'makeValhallaFreqEcho', params });
  }
  racks.push({ bus, plugins });
}

// Emit C++.
let out = `// AUTO-GENERATED by scripts/extract-rack-data.mjs — do not edit by hand.
// The AirWindows rack chains per fxGroup / aux return / master (PresetManager.h
// #if block, the golden AirWindows path). Each plugin: a factory name (AwPlugins.h)
// + its decoded [0,1] params. The MixGraph builds aw::Plugin chains from this.
#pragma once
#include <string>
#include <vector>
namespace casperaki { namespace mix {

struct RackPluginDef { std::string factory; std::vector<float> params; };
struct RackDef { std::string bus; std::vector<RackPluginDef> plugins; };

inline const std::vector<RackDef>& rackChains() {
    static const std::vector<RackDef> chains = {
`;
for (const r of racks) {
  out += `        { "${r.bus}", {\n`;
  for (const p of r.plugins) {
    // Always emit a valid float literal (toExponential keeps a decimal point + e);
    // sanitize non-finite (the opaque ValhallaFreqEcho chunk decodes to garbage) to 0.
    const ps = p.params.map((x) => `${(Number.isFinite(x) ? x : 0).toExponential(8)}f`).join(', ');
    out += `            { "${p.factory}", { ${ps} } },  // ${p.name}\n`;
  }
  out += `        } },\n`;
}
out += `    };
    return chains;
}

} } // namespace casperaki::mix
`;
writeFileSync(OUT, out);
console.log(`wrote ${OUT}: ${racks.length} racks`);
for (const r of racks) console.log(`  ${r.bus.padEnd(16)} ${r.plugins.map((p) => p.name).join(' -> ')}`);
if (unknownNames.size) console.log(`UNMAPPED plugin names (-> passthrough): ${[...unknownNames].join(', ')}`);
