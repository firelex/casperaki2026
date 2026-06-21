// docs/57a — Plugin-chain discovery smoke.
//
// Read-only structural pin on `scripts/check-plugin-chain.mjs`. Catches
// silent drift in three places at once:
//
//   1. PresetManager.h gaining / losing rack-preset constants
//      (the JUCE_PLUGINHOST_VST branch we walk).
//   2. The rack-preset XMLs losing their <PRESET>/<RACK>/<PLUGIN>
//      shape (truncated heredoc, missing close tag, etc.).
//   3. The Mac / Windows ExternalPlugins/ tree diverging from what
//      the rack XMLs reference — e.g. a future plugin removed from
//      disk without updating the preset.
//
// Does NOT enable, scan, or instantiate any external plugin at
// runtime — purely a static manifest comparison. Skipped silently
// when the sibling `casperaki_engine` checkout is absent (allows
// the test to live in the workspace without forcing the sibling
// dependency on every contributor).

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SCRIPT = resolve(ROOT, 'scripts/check-plugin-chain.mjs');
const ENGINE_REPO = process.env.CASPERAKI_ENGINE_REPO ?? resolve(ROOT, '../../../casperaki_engine');
const ENGINE_PRESENT = existsSync(resolve(ENGINE_REPO, 'Source/PresetManager.h'));

const describeIfEngine = ENGINE_PRESENT ? describe : describe.skip;

describeIfEngine('plugin-chain discovery smoke (docs/57a)', () => {
  const json = JSON.parse(
    execFileSync(process.execPath, [SCRIPT], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CASPERAKI_ENGINE_REPO: ENGINE_REPO },
      maxBuffer: 16 * 1024 * 1024,
    }).toString(),
  );

  it('discovers 15 rack presets (master + 4 fx + 10 instrument-group)', () => {
    expect(json.summary.rackCount).toBe(15);
    expect(json.summary.parseFailures).toBe(0);
  });

  it('every rack preset parses + names every expected group', () => {
    const expectedNames = [
      'PRESET_BALLAD_MASTER',
      'PRESET_BALLAD_FX_CHORUS',
      'PRESET_BALLAD_FX_PLATE_REVERB',
      'PRESET_BALLAD_FX_STEREO_DELAY',
      'PRESET_BALLAD_FX',
      'PRESET_BALLAD_KICKS',
      'PRESET_BALLAD_DRUMS',
      'PRESET_BALLAD_PERCUSSION',
      'PRESET_BALLAD_BASS',
      'PRESET_BALLAD_KEYS',
      'PRESET_BALLAD_SYNTHS',
      'PRESET_BALLAD_LEAD_SYNTHS',
      'PRESET_BALLAD_ACOU_GUITARS',
      'PRESET_BALLAD_ELEC_GUITARS',
      'PRESET_BALLAD_ORCHESTRAL',
    ];
    for (const name of expectedNames) {
      expect(json.racks[name], `missing rack ${name}`).toBeDefined();
      expect(json.racks[name].parseOk, `${name} parseOk: ${json.racks[name].parseError}`).toBe(true);
    }
  });

  it('every rack references at least one external VST plugin', () => {
    for (const [name, rack] of Object.entries<any>(json.racks)) {
      expect(rack.pluginRefs.length, `${name} has zero plugin refs`).toBeGreaterThan(0);
      for (const ref of rack.pluginRefs) {
        expect(ref.type, `${name}: plugin ref missing type`).toBe('vst');
        expect(typeof ref.filename, `${name}: plugin ref missing filename`).toBe('string');
        expect(ref.filename.length).toBeGreaterThan(0);
      }
    }
  });

  it('every plugin referenced is present on Windows disk (full coverage)', () => {
    for (const [stem, hit] of Object.entries<any>(json.pluginPresence.windows)) {
      expect(hit, `Windows missing ${stem} — preset XMLs reference it`).toBeTruthy();
    }
  });

  it('Mac disk covers all referenced plugins except known-missing list', () => {
    const knownMissing = new Set(['ADClip7']);
    for (const [stem, hit] of Object.entries<any>(json.pluginPresence.mac)) {
      if (knownMissing.has(stem)) {
        expect(hit, `${stem} suddenly appeared on Mac — update knownMissing`).toBeFalsy();
        continue;
      }
      expect(hit, `Mac missing ${stem} — preset XMLs reference it`).toBeTruthy();
    }
  });

  it('Linux is documented as having no ExternalPlugins/ tree', () => {
    expect(json.pluginPresence.linux).toMatch(/no Linux/i);
  });

  it('records the casperaki_spike JUCE_PLUGINHOST_* flag set verbatim', () => {
    expect(Array.isArray(json.pluginHostFlags)).toBe(true);
    // docs/57d flipped this row: the spike now sets
    // JUCE_PLUGINHOST_VST + VST3 + LV2 so PresetManager.h's
    // airwindows-bearing branch activates and the rack remap can
    // resolve external plugins via knownPluginList. AU stays off
    // (no Mac scan in Linux build).
    expect(json.pluginHostFlags).toEqual(
      expect.arrayContaining(['JUCE_PLUGINHOST_VST', 'JUCE_PLUGINHOST_VST3', 'JUCE_PLUGINHOST_LV2']),
    );
    expect(json.summary.pluginHostEnabled).toBe(true);
  });
});
