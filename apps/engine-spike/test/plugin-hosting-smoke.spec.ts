// docs/57b — Plugin-hosting smoke pin.
//
// Pins the behaviour of the casperaki_plugin_smoke binary. Skipped silently
// when the binary hasn't been built yet (matches the
// plugin-chain-discovery.spec pattern — keeps the test in the workspace
// without forcing every contributor to build the C++ smoke first).

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SCRIPT = resolve(ROOT, 'scripts/check-plugin-hosting.mjs');
const ARTEFACT_ROOT = resolve(ROOT, 'native/build/casperaki_plugin_smoke_artefacts');
const BIN_CANDIDATES = [
  resolve(ARTEFACT_ROOT, 'Debug/casperaki_plugin_smoke'),
  resolve(ARTEFACT_ROOT, 'Release/casperaki_plugin_smoke'),
  resolve(ARTEFACT_ROOT, 'casperaki_plugin_smoke'),
];
const BIN = process.env.CASPERAKI_PLUGIN_SMOKE_BIN ?? BIN_CANDIDATES.find((p) => existsSync(p));
const BIN_PRESENT = !!BIN && existsSync(BIN);

const describeIfBin = BIN_PRESENT ? describe : describe.skip;

describeIfBin('plugin-hosting smoke (docs/57b)', () => {
  const run = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, CASPERAKI_PLUGIN_SMOKE_BIN: BIN! },
  });
  const json = JSON.parse(run.stdout);

  it('binary exits 0 (all overlap plugins instantiated + pyewacket diverged)', () => {
    expect(run.status).toBe(0);
    expect(json.errors).toEqual([]);
  });

  it('JUCE plugin-format manager has VST3 + LV2 registered', () => {
    expect(json.formats).toEqual(expect.arrayContaining(['VST3', 'LV2']));
  });

  it('instantiates all 6 Tracktion-internal Airwindows overlap plugins', () => {
    expect(json.summary.instantiated).toBe(6);
    expect(json.summary.expected).toBe(6);
    for (const entry of json.internalAirWindows) {
      expect(entry.instantiated).toBe(true);
      expect(entry.numParams).toBeGreaterThan(0);
    }
  });

  it('overlap covers exactly the legacy 6 (Pyewacket/EQ/Logical4/NC-17/Thunder/ADClip7)', () => {
    const legacy = json.internalAirWindows.map((e: { legacy: string }) => e.legacy);
    expect(legacy.sort()).toEqual(
      ['ADClip7', 'EQ', 'Logical4', 'NC-17', 'Pyewacket', 'Thunder'].sort(),
    );
  });

  it('Pyewacket processes the noise buffer (output diverges from input)', () => {
    expect(json.pyewacket.ran).toBe(true);
    expect(json.pyewacket.diverged).toBe(true);
    expect(json.pyewacket.samples).toBe(4096);
    expect(json.pyewacket.inRms).toBeGreaterThan(0);
    expect(json.pyewacket.outRms).toBeGreaterThan(0);
    // RMS ratio falls in a sane window — bypassed would be exactly 1.0,
    // silence would be 0. Pyewacket at defaults typically lands in (0.5, 1.1).
    expect(json.pyewacket.ratio).toBeGreaterThan(0.1);
    expect(json.pyewacket.ratio).toBeLessThan(1.5);
  });

  it('reports VST3 / LV2 dir contents (empty today, populated post 57c)', () => {
    expect(Array.isArray(json.vst3DirContents)).toBe(true);
    expect(Array.isArray(json.lv2DirContents)).toBe(true);
  });
});

// --scan-external path — only runs if the Consolidated bundle is present
// under ~/.vst3. Skipped silently otherwise so contributors without the
// bundle don't see false failures.
const CONSOLIDATED_PRESENT =
  BIN_PRESENT &&
  existsSync(
    resolve(
      process.env.HOME ?? '',
      '.vst3/Airwindows Consolidated.vst3',
    ),
  );

const describeIfConsolidated = CONSOLIDATED_PRESENT ? describe : describe.skip;

describeIfConsolidated('Airwindows Consolidated scanner + algorithm-selector probe (docs/57c)', () => {
  const run = spawnSync(BIN!, ['--scan-external'], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const json = JSON.parse(run.stdout);

  it('loads Consolidated VST3 + LV2 via JUCE format scanners', () => {
    expect(json.scannedExternal).toBe(true);
    const formats = (json.externalPlugins as Array<{ format: string; name: string; loaded: boolean }>)
      .filter((p) => p.name === 'Airwindows Consolidated')
      .map((p) => `${p.format}:${p.loaded}`);
    expect(formats).toEqual(expect.arrayContaining(['VST3:true', 'LV2:true']));
  });

  it('loads SimpleSide VST3 if installed (docs/57d-A)', () => {
    const simpleside = (json.externalPlugins as Array<{
      format: string;
      name: string;
      vendor: string;
      loaded: boolean;
      numParameters: number;
    }>).find((p) => p.name === 'SimpleSide');
    // Skip-style assertion: only check if the SimpleSide bundle is present.
    // The harness instructs contributors to install it via
    // `cmake --build … --target SimpleSide_VST3` + `cp` to ~/.vst3, but
    // we don't fail CI if it's absent.
    if (simpleside) {
      expect(simpleside.format).toBe('VST3');
      expect(simpleside.vendor).toBe('Armando Montanez');
      expect(simpleside.loaded).toBe(true);
      expect(simpleside.numParameters).toBeGreaterThanOrEqual(2);
    }
  });

  it('loads ValhallaFreqEcho via yabridge if Wine + yabridge are set up (docs/57d-B)', () => {
    const valhalla = (json.externalPlugins as Array<{
      format: string;
      name: string;
      vendor: string;
      loaded: boolean;
      numParameters: number;
    }>).find((p) => p.name.includes('ValhallaFreqEcho'));
    // Skip-style: only fail if Valhalla appears in the scan AND fails to load.
    // Contributors without Wine + yabridge see no entry, test passes.
    if (valhalla) {
      expect(valhalla.format).toBe('VST');
      expect(valhalla.vendor).toBe('Valhalla DSP, LLC');
      expect(valhalla.loaded).toBe(true);
      expect(valhalla.numParameters).toBeGreaterThanOrEqual(4);
    }
  });

  it('algorithm-selector round-trip succeeds (state blob → Console8SubIn → read back)', () => {
    const p = json.consolidatedAlgoProbe;
    expect(p.ran).toBe(true);
    expect(p.targetAlgo).toBe('Console8SubIn');
    expect(p.selectedAlgo).toBe('Console8SubIn');
    expect(p.matched).toBe(true);
    expect(p.readBackRootTag).toBe('VST3PluginState');
    expect(p.readBackChildren).toContain('IComponent');
  });
});
