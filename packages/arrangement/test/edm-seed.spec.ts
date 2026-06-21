// docs/56b — EDM canonical seed acceptance tests.
//
// Mirrors the brightPop orchestrate spec's structural assertions for
// the edm seed: deterministic, schema-valid, and the expected lanes
// activate (Drums / Bass / Synths / PluckedSynths / Loop / vocals)
// while the lanes the catalog has no edm rows for (Keys / Pad /
// Guitar) explicitly stay false.

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  canonicalStringifySong,
  parseSong,
  safeParseSong,
  type Song,
} from '@casperaki/song-schema';

import { orchestrate, type GenerateParams } from '../src/index.js';
import { ORCHESTRATE_GOLDEN_CASES, orchestrateGoldenPath } from './fixtures.js';

const EDM_PARAMS: GenerateParams = {
  genre: 'edm',
  key: 'C',
  bpm: 128,
  seed: 'edm-vertical-slice',
};

const EDM_CASE = ORCHESTRATE_GOLDEN_CASES.find((c) => c.genre === 'edm')!;

describe('orchestrate (edm vertical slice)', () => {
  it('returns a parseSong-valid Song', () => {
    const song = orchestrate(EDM_PARAMS);
    const parsed = safeParseSong(song);
    expect(parsed.ok, parsed.ok ? '' : parsed.error.message).toBe(true);
  });

  it('semantic validation produces no warnings', () => {
    const song = orchestrate(EDM_PARAMS);
    const parsed = safeParseSong(song);
    if (!parsed.ok) throw parsed.error;
    expect(parsed.semantic.errors).toEqual([]);
    expect(parsed.semantic.warnings).toEqual([]);
  });

  it('produces 9 segments at 128bpm (intro/verse/chorus/break/bridge/outro shape)', () => {
    const song = orchestrate(EDM_PARAMS);
    expect(song.songStructure.length).toBe(9);
    const names = song.songStructure.map((s) => s.name);
    expect(names[0]).toBe('intro');
    expect(names).toContain('break1');
    expect(names).toContain('bridge1');
    expect(names[names.length - 1]).toBe('outro');
  });

  it('is reproducible: same seed twice → byte-identical canonical Song', () => {
    const a = canonicalStringifySong(orchestrate(EDM_PARAMS), 2);
    const b = canonicalStringifySong(orchestrate(EDM_PARAMS), 2);
    expect(a).toBe(b);
  });

  it('instrumentDefinitions reflect the edm roll (essentials + Loop; no Guitar)', () => {
    const song = orchestrate(EDM_PARAMS);
    const byName = new Map(song.instrumentDefinitions.map((d) => [d.name, d]));
    // Essentials + the percussion loop are always present.
    for (const name of ['Drums', 'Bass', 'Pad', 'Loop']) {
      const def = byName.get(name);
      expect(def, `missing instrumentDefinition for ${name}`).toBeDefined();
    }
    // docs/58i — the edm decision tree never rolls a guitar, and the edm
    // "add one" permitted-set has no guitar either, so no Guitar lane appears.
    expect(byName.get('Guitar'), 'Guitar should not be in edm InstrumentDefinitions').toBeUndefined();
  });

  it('Synths and PluckedSynths route through the right catalog families', () => {
    const song = orchestrate(EDM_PARAMS);
    const synths = song.instrumentDefinitions.find((d) => d.name === 'Synths');
    const plucked = song.instrumentDefinitions.find((d) => d.name === 'PluckedSynths');
    expect(synths?.instrumentGroup).toBe('leadSynths');
    expect(['leadSynthsAnalog', 'leadSynthsBright', 'leadSynthsSoft']).toContain(synths?.lowLevelType ?? '');
    expect(plucked?.instrumentGroup).toBe('synths');
    expect(plucked?.lowLevelType).toBe('synthsPlucked');
  });

  it('per-segment activation follows the lane model (essentials everywhere; choruses agree)', () => {
    // docs/58i — Drums + Bass + Pad are essential lanes, active in EVERY
    // segment (legacy non-chorus mandatory set). Chorus segments share a
    // single per-type activation (chorus1 === chorus2 === …).
    const song = orchestrate(EDM_PARAMS);
    for (const [segName, payload] of Object.entries(song.arrangement)) {
      const inst = payload.instruments;
      expect(inst.Drums, `${segName} Drums`).toBe(true);
      expect(inst.Bass, `${segName} Bass`).toBe(true);
      expect(inst.Pad, `${segName} Pad`).toBe(true);
    }
    const choruses = Object.entries(song.arrangement).filter(([n]) => n.startsWith('chorus'));
    const sig = (p: (typeof choruses)[number][1]) =>
      Object.entries(p.instruments).filter(([, v]) => v).map(([k]) => k).sort().join(',');
    for (const [, p] of choruses) expect(sig(p)).toBe(sig(choruses[0]![1]));
  });

  it('emits noteRelative events for PluckedSynths from the edmSynthsPluckedLibrary bank', () => {
    const song = orchestrate(EDM_PARAMS);
    let totalNoteRelative = 0;
    for (const [, payload] of Object.entries(song.arrangement)) {
      const ov = (payload.overrides as Record<string, { bars?: Array<{ notes?: Record<string, Array<{ type: string }>> }> }> | undefined)?.PluckedSynths;
      if (!ov?.bars) continue;
      for (const bar of ov.bars) {
        for (const events of Object.values(bar.notes ?? {})) {
          for (const ev of events) if (ev.type === 'noteRelative') totalNoteRelative++;
        }
      }
    }
    expect(totalNoteRelative).toBeGreaterThan(0);
  });

  it('matches committed golden Song fixture (edm / edm-vertical-slice)', async () => {
    const song = orchestrate(EDM_PARAMS);
    const generated = `${canonicalStringifySong(song, 2)}\n`;
    const golden = await readFile(orchestrateGoldenPath(EDM_CASE.genre, EDM_CASE.seed), 'utf8');
    expect(generated).toBe(golden);
  });

  it('canonicalStringifySong is idempotent for the edm song', () => {
    const song = orchestrate(EDM_PARAMS);
    const once = canonicalStringifySong(song, 2);
    const twice = canonicalStringifySong(parseSong(JSON.parse(once)), 2);
    expect(twice).toBe(once);
  });

  it('brightPop and edm produce different musical content (no genre crosstalk)', () => {
    const bp = orchestrate({ genre: 'brightPop', key: 'C', bpm: 120, seed: 'brightPop-vertical-slice' });
    const edm = orchestrate(EDM_PARAMS);
    const bpStr = canonicalStringifySong(bp as Song, 2);
    const edmStr = canonicalStringifySong(edm, 2);
    expect(bpStr).not.toBe(edmStr);
  });
});
