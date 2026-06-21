#!/usr/bin/env node
// docs/57a — Non-invasive plugin-chain discovery smoke.
//
// Read-only. Does NOT enable, scan, or instantiate any external plugin
// at runtime. Reports:
//   - Which rack preset XML strings the engine's PresetManager.h
//     exposes, and whether each parses as well-formed XML.
//   - For each rack, the embedded PLUGIN filename references — both
//     the legacy Mac (.vst) and Windows (.dll) variants.
//   - Which plugin filenames exist on disk under
//     casperaki_engine/ExternalPlugins/{Mac,Windows} (and a note when
//     neither is present, e.g. the Linux render target).
//   - The casperaki_spike build's JUCE_PLUGINHOST_* defines, so the
//     reader knows whether the binary could load anything even if the
//     plugin files were available.
//
// Run:
//   node apps/engine-spike/scripts/check-plugin-chain.mjs
//   CASPERAKI_ENGINE_REPO=/abs/path node ... check-plugin-chain.mjs
//
// Exit code: 0 if the inventory completed (regardless of disk hits);
// 1 only if PresetManager.h itself can't be read or any rack XML
// fails to parse. The doc 57a explains why a 0 + a sparse disk table
// is the expected Linux state.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const ENGINE_REPO = process.env.CASPERAKI_ENGINE_REPO ?? resolve(REPO_ROOT, '../casperaki_engine');
const PRESET_MGR = join(ENGINE_REPO, 'Source/PresetManager.h');
const EXTERNAL_PLUGINS = join(ENGINE_REPO, 'ExternalPlugins');
const SPIKE_DEFS = resolve(
  REPO_ROOT,
  'apps/engine-spike/native/build/casperaki_spike_artefacts/JuceLibraryCode/Debug/Defs.txt',
);

if (!existsSync(PRESET_MGR)) {
  console.error(`[plugin-chain] PresetManager.h not found at ${PRESET_MGR}`);
  console.error(`[plugin-chain] set CASPERAKI_ENGINE_REPO=/abs/path to override`);
  process.exit(1);
}

const presetSource = readFileSync(PRESET_MGR, 'utf-8');

// Extract every `inline static const juce::String PRESET_BALLAD_<NAME> = R"(...)";`
// block. Two definitions exist per name — one under `#if JUCE_PLUGINHOST_VST`
// (with the airwindows VST filenames) and one in the `#else` branch
// (rack templates without plugins). We capture the VST-enabled
// variant by taking the FIRST definition's body.
//
// The regex matches the C++ raw-string literal R"(...)" — there is no
// escape inside, so we can scan greedily for `)";` as the end token.
const presetBlocks = new Map();
{
  const re = /inline\s+static\s+const\s+juce::String\s+(PRESET_BALLAD_[A-Z_]+)\s*=\s*R"\(([\s\S]*?)\)";/g;
  let m;
  while ((m = re.exec(presetSource)) !== null) {
    const name = m[1];
    if (!presetBlocks.has(name)) presetBlocks.set(name, m[2]);
  }
}

if (presetBlocks.size === 0) {
  console.error(`[plugin-chain] No PRESET_BALLAD_* constants matched in ${PRESET_MGR}`);
  process.exit(1);
}

// Minimal XML structural parse — the rack XMLs are flat enough that a
// regex pass over PLUGININSTANCE → PLUGIN attributes is enough and
// doesn't need a runtime XML dependency. We DO sanity-check the
// PRESET / RACK tag presence so a malformed body (truncated heredoc,
// missing closing tag) trips parseFailures.
function parseRackBody(body) {
  const trimmed = body.trim();
  if (!/<PRESET\b/.test(trimmed) || !/<RACK\b/.test(trimmed)) {
    return { ok: false, error: 'missing <PRESET> or <RACK> tag', plugins: [] };
  }
  if (!/<\/RACK>/.test(trimmed) || !/<\/PRESET>/.test(trimmed)) {
    return { ok: false, error: 'missing </RACK> or </PRESET> close tag', plugins: [] };
  }
  const plugins = [];
  const pluginRe = /<PLUGIN\b([^>]*?)(?:\/>|>)/g;
  let pm;
  while ((pm = pluginRe.exec(trimmed)) !== null) {
    const attrs = parseAttrs(pm[1]);
    if (!attrs.filename) continue;
    plugins.push({
      filename: attrs.filename,
      basename: (attrs.filename.split(/[/\\]/).pop() ?? ''),
      manufacturer: attrs.manufacturer ?? null,
      pluginName: attrs.name ?? null,
      type: attrs.type ?? null,
      uniqueId: attrs.uniqueId ?? null,
    });
  }
  return { ok: true, error: null, plugins };
}

function parseAttrs(attrText) {
  const out = {};
  const re = /(\w+)\s*=\s*"([^"]*)"/g;
  let am;
  while ((am = re.exec(attrText)) !== null) {
    out[am[1]] = am[2];
  }
  return out;
}

const report = {
  generatedBy: 'check-plugin-chain.mjs',
  enginePresetFile: PRESET_MGR,
  externalPluginsRoot: EXTERNAL_PLUGINS,
  spikeDefsFile: SPIKE_DEFS,
  pluginHostFlags: probePluginHostFlags(SPIKE_DEFS),
  racks: {},
  pluginInventory: {},
  pluginPresence: { mac: {}, windows: {}, linux: 'no Linux ExternalPlugins/ tree shipped' },
  summary: {},
};

const macDir = join(EXTERNAL_PLUGINS, 'Mac');
const winDir = join(EXTERNAL_PLUGINS, 'Windows');
const macSet = existsSync(macDir) ? new Set(readdirSync(macDir)) : new Set();
const winSet = existsSync(winDir) ? new Set(readdirSync(winDir)) : new Set();

let parseFailures = 0;
let totalPluginRefs = 0;

for (const [name, body] of presetBlocks) {
  const rack = {
    name,
    parseOk: false,
    parseError: null,
    pluginRefs: [],
  };
  const parsed = parseRackBody(body);
  rack.parseOk = parsed.ok;
  rack.parseError = parsed.error;
  if (!parsed.ok) parseFailures++;
  for (const ref of parsed.plugins) {
    rack.pluginRefs.push(ref);
    totalPluginRefs++;
    report.pluginInventory[ref.basename] = (report.pluginInventory[ref.basename] ?? 0) + 1;
  }
  report.racks[name] = rack;
}

// Pair Mac/Windows variants by stripping the `64.dll` / `.dll` / `.vst` suffix.
function stem(basename) {
  if (basename.endsWith('64.dll')) return basename.slice(0, -6);
  if (basename.endsWith('.dll')) return basename.slice(0, -4);
  if (basename.endsWith('.vst')) return basename.slice(0, -4);
  return basename;
}

const uniquePlugins = new Set(Object.keys(report.pluginInventory).map(stem));
for (const plugin of [...uniquePlugins].sort()) {
  // FX.h `transformVSTPath` special-cases ValhallaFreqEcho_x64.dll →
  // ValhallaFreqEcho.vst on Mac; mirror that here so the disk-presence
  // report doesn't false-positive on the rename quirk.
  const stripUnderscoreX = plugin.endsWith('_x') ? plugin.slice(0, -2) : plugin;
  const macCandidates = [
    `${plugin}.vst`,
    `${plugin} 2.vst`,
    `${stripUnderscoreX}.vst`,
    `${stripUnderscoreX} 2.vst`,
  ];
  const winCandidates = [
    `${plugin}64.dll`,
    `${plugin}.dll`,
    `${plugin}_x64.dll`,
  ];
  const macHit = macCandidates.find((c) => macSet.has(c)) ?? null;
  const winHit = winCandidates.find((c) => winSet.has(c)) ?? null;
  report.pluginPresence.mac[plugin] = macHit;
  report.pluginPresence.windows[plugin] = winHit;
}

const macMissing = Object.values(report.pluginPresence.mac).filter((v) => !v).length;
const winMissing = Object.values(report.pluginPresence.windows).filter((v) => !v).length;
const totalPlugins = uniquePlugins.size;

report.summary = {
  rackCount: presetBlocks.size,
  parseFailures,
  totalPluginRefs,
  uniquePlugins: totalPlugins,
  macPresent: totalPlugins - macMissing,
  windowsPresent: totalPlugins - winMissing,
  pluginHostEnabled: report.pluginHostFlags.length > 0,
};

// Stdout JSON for downstream consumers (tests, CI).
console.log(JSON.stringify(report, null, 2));

// Stderr human summary.
console.error('');
console.error('[plugin-chain] discovery summary');
console.error(`  racks parsed   : ${report.summary.rackCount - parseFailures}/${report.summary.rackCount}`);
console.error(`  plugin refs    : ${report.summary.totalPluginRefs}`);
console.error(`  unique plugins : ${report.summary.uniquePlugins}`);
console.error(`  on Mac disk    : ${report.summary.macPresent}/${report.summary.uniquePlugins}`);
console.error(`  on Win disk    : ${report.summary.windowsPresent}/${report.summary.uniquePlugins}`);
console.error(`  Linux disk     : (no ExternalPlugins/Linux dir — see docs/57a)`);
console.error(`  spike plugin-host flags: ${report.pluginHostFlags.join(', ') || '(none — render path cannot host external plugins under current build)'}`);

if (parseFailures > 0) {
  console.error(`[plugin-chain] FAIL: ${parseFailures} rack XML(s) did not parse`);
  process.exit(1);
}
process.exit(0);

function probePluginHostFlags(defsFile) {
  if (!existsSync(defsFile)) return [];
  const txt = readFileSync(defsFile, 'utf-8');
  const flags = [];
  for (const tok of txt.split(/[;\s]+/)) {
    const m = tok.match(/^(JUCE_PLUGINHOST_[A-Z0-9]+)=(\d+)$/);
    if (m && m[2] === '1') flags.push(m[1]);
  }
  return flags;
}

