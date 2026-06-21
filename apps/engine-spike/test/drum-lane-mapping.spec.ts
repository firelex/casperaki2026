// Drum lane → catalog component family mapping — docs/54j Stage 2.
//
// Reads the emitted `out/brain-roundtrip/asset-manifest.json` produced
// by `pnpm emit:brain-roundtrip` and pins the lane → family routing:
//
//   bassDrum*    → kickDrums
//   snareDrum*   → snareDrums
//   hiHatClosed* → hiHatsClosed
//   hiHatPedal   → hiHatsClosed
//   hiHatOpen    → hiHatsOpen
//   clap / snap  → clapsSnaps
//   crash* / ride → cymbals
//   shaker       → shakers
//   tom*         → toms
//
// These mappings come from the brief: "kick 36 → kickDrums, snare 38 →
// snareDrums, closed hat 42 → hiHatsClosed, open hat → hiHatsOpen".

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT = resolve(ROOT, 'out/brain-roundtrip');
const ADAPTER = resolve(ROOT, 'scripts/emit-brain-roundtrip.mjs');

function runAdapter(): void {
  execFileSync(process.execPath, [ADAPTER], { stdio: 'pipe' });
}

function readManifest() {
  if (!existsSync(resolve(OUT, 'asset-manifest.json'))) runAdapter();
  return JSON.parse(
    readFileSync(resolve(OUT, 'asset-manifest.json'), 'utf-8'),
  ) as {
    Drums?: {
      laneFamilyMap?: Record<string, string>;
      lanes?: Record<
        string,
        { status: string; family?: string; relativePath?: string; entryId?: string }
      >;
    };
  };
}

describe('drum lane → component family mapping', () => {
  it('asset-manifest.json#Drums.laneFamilyMap routes each role to the documented family', () => {
    const manifest = readManifest();
    expect(manifest.Drums?.laneFamilyMap).toBeDefined();
    const m = manifest.Drums!.laneFamilyMap!;

    // The four families called out in the task brief.
    expect(m.bassDrum1).toBe('kickDrums');
    expect(m.snareDrum1).toBe('snareDrums');
    expect(m.hiHatClosed1).toBe('hiHatsClosed');
    expect(m.hiHatOpen).toBe('hiHatsOpen');

    // The other 13 engine lanes are routed to component families the
    // catalog actually has audited rows for.
    expect(m.bassDrum2).toBe('kickDrums');
    expect(m.snareDrum2).toBe('snareDrums');
    expect(m.hiHatClosed2).toBe('hiHatsClosed');
    expect(m.hiHatPedal).toBe('hiHatsClosed');
    expect(m.clap).toBe('clapsSnaps');
    expect(m.snap).toBe('clapsSnaps');
    expect(m.crash1).toBe('cymbals');
    expect(m.crash2).toBe('cymbals');
    expect(m.ride).toBe('cymbals');
    expect(m.shaker).toBe('shakers');
    expect(m.tom1).toBe('toms');
    expect(m.tom2).toBe('toms');
    expect(m.tom3).toBe('toms');
  });

  it('every engine drum lane carries a per-lane verdict (resolved or unresolved)', () => {
    const manifest = readManifest();
    const lanes = manifest.Drums?.lanes ?? {};
    const expectedRoles = [
      'bassDrum1', 'bassDrum2', 'snareDrum1', 'snareDrum2',
      'clap', 'snap',
      'hiHatClosed1', 'hiHatClosed2', 'hiHatPedal', 'hiHatOpen',
      'crash1', 'crash2', 'ride', 'shaker',
      'tom1', 'tom2', 'tom3',
    ];
    for (const role of expectedRoles) {
      expect(lanes[role], `missing verdict for ${role}`).toBeDefined();
      expect(['resolved', 'unresolved']).toContain(lanes[role]!.status);
      // family is always echoed back so the prestage log can render it.
      expect(typeof lanes[role]!.family).toBe('string');
    }
  });

  it('every resolved lane points at the family it was mapped to (no cross-family resolution leak)', () => {
    const manifest = readManifest();
    const lanes = manifest.Drums?.lanes ?? {};
    const map = manifest.Drums?.laneFamilyMap ?? {};
    for (const [role, lane] of Object.entries(lanes)) {
      if (lane.status !== 'resolved') continue;
      expect(lane.family).toBe(map[role]);
      // The relative path starts with the family folder name.
      expect(lane.relativePath).toMatch(new RegExp(`^${lane.family}/`));
    }
  });
});
