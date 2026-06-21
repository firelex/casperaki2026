// docs/56d — all-genre summary.example.json schema pin.
//
// Cheap structural lock on the shape that `render-all-genres.mjs`
// writes. A future refactor that drops, renames, or re-typeds a field
// must update both the fixture and this spec — preventing silent
// schema drift that would break downstream consumers (CI dashboards,
// future fixture-gate comparisons, etc.). The fixture lives at
// `out/all-genre-render-smoke/summary.example.json` and is regenerated
// by running the driver script once and copying the result.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const FIXTURE = resolve(ROOT, 'out/all-genre-render-smoke/summary.example.json');

const CANONICAL_GENRES = [
  'ballad',
  'brightPop',
  'edm',
  'latin',
  'organicVibes',
  'rock',
  'schlager',
  'urban',
] as const;

describe('all-genre summary.example.json schema (docs/56d)', () => {
  it('fixture exists at the expected path', () => {
    expect(existsSync(FIXTURE), `regenerate via: node apps/engine-spike/scripts/render-all-genres.mjs && cp out/all-genre-render-smoke/summary.json out/all-genre-render-smoke/summary.example.json`).toBe(true);
  });

  it('top-level fields are present and well-typed', () => {
    if (!existsSync(FIXTURE)) return; // gated by the existence test above
    const j = JSON.parse(readFileSync(FIXTURE, 'utf-8'));
    expect(j.generatedBy).toBe('render-all-genres.mjs');
    expect(typeof j.binary).toBe('string');
    expect(j.gateTrio).toEqual({
      durationMinSec: 30,
      peakMinDb: -40,
      rmsMinDb: -35,
    });
    expect(typeof j.laneDeltaDb).toBe('number');
    expect(typeof j.transitionDeltaDb).toBe('number');
    expect(typeof j.elapsedSec).toBe('number');
    expect(typeof j.genres).toBe('object');
  });

  it('every canonical genre that ran emits the documented row shape', () => {
    if (!existsSync(FIXTURE)) return;
    const j = JSON.parse(readFileSync(FIXTURE, 'utf-8'));
    const ran = Object.keys(j.genres ?? {});
    expect(ran.length, 'no per-genre rows recorded').toBeGreaterThan(0);

    for (const genre of ran) {
      const r = j.genres[genre];
      expect(CANONICAL_GENRES, `genre "${genre}" not in canonical list`).toContain(genre);
      // Top-of-row identity.
      expect(r.genre).toBe(genre);
      expect(typeof r.seed).toBe('string');
      expect(['pass', 'fail', 'error', 'running']).toContain(r.status);

      // Stamped metrics — present on every non-error row.
      if (r.status !== 'error') {
        expect(typeof r.durationSec).toBe('number');
        expect(typeof r.peakDb).toBe('number');
        expect(typeof r.rmsDb).toBe('number');
        expect(Array.isArray(r.activeFamilies)).toBe(true);
        expect(typeof r.transitionsActive).toBe('boolean');
        expect(typeof r.tempo).toBe('number');
        expect(typeof r.key).toBe('string');
        expect(r.genreOnSong).toBe(genre);
        expect(typeof r.familyResolution).toBe('object');
        expect(Array.isArray(r.fallbackPicks)).toBe(true);
        expect(r.gateTrio).toMatchObject({ ok: expect.any(Boolean), reasons: expect.any(Array) });
        expect(typeof r.laneActiveWindows).toBe('object');
        expect(Array.isArray(r.perSegmentStats)).toBe(true);
        expect(typeof r.segmentFloorDb).toBe('number');
        expect(Array.isArray(r.failures)).toBe(true);
      }
    }
  });

  it('every recorded perSegmentStats row carries the timeline span shape', () => {
    if (!existsSync(FIXTURE)) return;
    const j = JSON.parse(readFileSync(FIXTURE, 'utf-8'));
    for (const r of Object.values<any>(j.genres ?? {})) {
      if (r.status === 'error') continue;
      for (const seg of r.perSegmentStats ?? []) {
        expect(typeof seg.segment).toBe('string');
        expect(typeof seg.startSec).toBe('number');
        expect(typeof seg.endSec).toBe('number');
        // rmsDb may be `null` on a degenerate (silent) segment; peakDb too.
        if (seg.rmsDb !== null) expect(typeof seg.rmsDb).toBe('number');
        if (seg.peakDb !== null) expect(typeof seg.peakDb).toBe('number');
        expect(typeof seg.belowFloor).toBe('boolean');
      }
    }
  });
});
