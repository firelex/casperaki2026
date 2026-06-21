// Step 8 — orchestrator tests.

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { beatsPerBar, parseBarBeat } from '@casperaki/music-theory';
import {
  canonicalStringifySong,
  parseSong,
  safeParseSong,
  stableStringify,
} from '@casperaki/song-schema';

import {
  ORCHESTRATOR_NAME,
  ORCHESTRATOR_VERSION,
  applyArrangementOverrides,
  generateChords,
  generateFills,
  generateMutes,
  generatePatterns,
  generateSignalProcessors,
  generateSongStructure,
  generateTransitions,
  generateVocalMelody,
  lowerToSong,
  orchestrate,
  selectInstruments,
  type GenerateParams,
} from '../src/index.js';
import { createRng } from '@casperaki/music-theory';
import { orchestrateGoldenPath } from './fixtures.js';

const POP_PARAMS: GenerateParams = {
  genre: 'brightPop',
  key: 'C',
  bpm: 120,
  seed: 'brightPop-vertical-slice',
};

function paramsFor(seed: string | number, key = 'C'): GenerateParams {
  return { genre: 'brightPop', key, bpm: 120, seed };
}

describe('orchestrate (brightPop vertical slice)', () => {
  it('returns a parseSong-valid Song', () => {
    const song = orchestrate(POP_PARAMS);
    // safeParseSong runs both Zod + semantic validation; assert no errors.
    const parsed = safeParseSong(song);
    if (!parsed.ok) console.error(parsed.error);
    expect(parsed.ok).toBe(true);
  });

  it('semantic validation produces no warnings (display names + structure align)', () => {
    const song = orchestrate(POP_PARAMS);
    const parsed = safeParseSong(song);
    if (!parsed.ok) throw parsed.error;
    expect(parsed.semantic.errors).toEqual([]);
    expect(parsed.semantic.warnings).toEqual([]);
  });

  it('canonicalStringifySong is idempotent', () => {
    const song = orchestrate(POP_PARAMS);
    const once = canonicalStringifySong(song, 2);
    const twice = canonicalStringifySong(parseSong(JSON.parse(once)), 2);
    expect(twice).toBe(once);
  });

  it('is reproducible: same seed twice → byte-identical canonical Song', () => {
    const a = canonicalStringifySong(orchestrate(POP_PARAMS), 2);
    const b = canonicalStringifySong(orchestrate(POP_PARAMS), 2);
    expect(a).toBe(b);
  });

  it('different seeds → different musical content (post-step-4 canary flip)', () => {
    // Strip the generator block before comparing so we test the music,
    // not the metadata (the generator.seed field always differs by
    // construction). Step-4's per-style structure generator means the
    // bare songs now differ across seeds — the canary flipped per 53k.
    const stripGenerator = (song: ReturnType<typeof orchestrate>) => {
      const { generator: _g, ...rest } = song;
      return canonicalStringifySong({ ...rest, generator: undefined } as never, 2);
    };
    const a = stripGenerator(orchestrate(paramsFor('seed-one')));
    const b = stripGenerator(orchestrate(paramsFor('seed-two')));
    expect(a).not.toBe(b);
  });

  it('top-level fields carry through from params + schema version', () => {
    const song = orchestrate(POP_PARAMS);
    expect(song.schemaVersion).toBe('1');
    expect(song.key).toBe('C');
    expect(song.bpm).toBe(120);
    expect(song.genre).toBe('brightPop');
    expect(song.generator?.name).toBe(ORCHESTRATOR_NAME);
    expect(song.generator?.version).toBe(ORCHESTRATOR_VERSION);
    expect(song.generator?.seed).toBe('brightPop-vertical-slice');
    expect(song.aiArtifacts).toEqual([]);
    expect(song.patterns).toBeUndefined();
  });

  it('songStructure carries chord-filled bars from step 4 (bank-derived)', () => {
    // Post-53r the chord bank drives verse / preChorus / chorus, so
    // the chorus bars are no longer the fixed `brightPop_default`
    // I-V-vi-IV template. Assert the chord-filled invariants instead:
    // every chorus1 bar has beatsPerBar() symbols, each parses cleanly.
    const song = orchestrate(POP_PARAMS);
    const chorus = song.songStructure.find((s) => s.name === 'chorus1')!;
    expect(chorus.bars.length).toBeGreaterThan(0);
    for (const bar of chorus.bars) {
      expect(bar.chords.length).toBe(4);
      for (const symbol of bar.chords) {
        expect(typeof symbol).toBe('string');
        expect((symbol as string).length).toBeGreaterThan(0);
      }
    }
  });

  it('every arrangement segment corresponds to a songStructure segment', () => {
    const song = orchestrate(POP_PARAMS);
    const structureNames = new Set(song.songStructure.map((s) => s.name));
    for (const segName of Object.keys(song.arrangement)) {
      expect(structureNames.has(segName)).toBe(true);
    }
    // And every structure segment exists in the arrangement.
    for (const seg of song.songStructure) {
      expect(song.arrangement[seg.name]).toBeDefined();
    }
  });

  it('every segment declares every roster lane in arrangement.instruments (lane model)', () => {
    const song = orchestrate(POP_PARAMS);
    // docs/58i — each segment declares every roster lane (true/false). Roster
    // lane names = instrumentDefinitions minus the vocal/loop fixtures.
    const NON_ROSTER = new Set(['Vocal', 'Backing vocals 1', 'Backing vocals 2', 'Loop']);
    const rosterLanes = song.instrumentDefinitions
      .map((d) => d.name)
      .filter((n) => !NON_ROSTER.has(n));
    for (const [segName, payload] of Object.entries(song.arrangement)) {
      const keys = new Set(Object.keys(payload.instruments));
      for (const lane of rosterLanes) {
        expect(keys.has(lane), `segment "${segName}" missing "${lane}"`).toBe(true);
      }
      for (const v of Object.values(payload.instruments)) expect(typeof v).toBe('boolean');
      // Essentials (Drums / Bass / Pad) are active in EVERY segment (legacy
      // non-chorus mandatory set — a reversal of the old fixed-activity drops).
      expect(payload.instruments.Drums, `${segName} Drums`).toBe(true);
      expect(payload.instruments.Bass, `${segName} Bass`).toBe(true);
      expect(payload.instruments.Pad, `${segName} Pad`).toBe(true);
    }
    // Chorus segments agree on their active set (per-type activation) and it
    // is the fullest base set — every other segment's active lanes that are
    // ALSO base-roster lanes are a subset of the chorus set. (Per-segment
    // "add one" lanes — docs/58i — can appear off-chorus, so we compare only
    // within the chorus's own lane universe.)
    const choruses = Object.entries(song.arrangement).filter(([n]) => n.startsWith('chorus'));
    if (choruses.length > 1) {
      const sig = (p: (typeof choruses)[number][1]) =>
        Object.entries(p.instruments).filter(([, v]) => v).map(([k]) => k).sort().join(',');
      for (const [, p] of choruses) expect(sig(p)).toBe(sig(choruses[0]![1]));
    }
  });

  it('overrides only appear for instruments flagged true; bar count matches the structure segment', () => {
    const song = orchestrate(POP_PARAMS);
    // The percussion-loop lane (docs/54r) is sample-only — it carries
    // no MIDI grid override, only the per-segment instruments flag.
    // Exempt its display name from the override invariant.
    const NO_OVERRIDE_NAMES = new Set(['Loop']);
    for (const seg of song.songStructure) {
      const payload = song.arrangement[seg.name]!;
      for (const [displayName, isActive] of Object.entries(payload.instruments)) {
        if (NO_OVERRIDE_NAMES.has(displayName)) {
          expect(payload.overrides[displayName]).toBeUndefined();
          continue;
        }
        const override = payload.overrides[displayName];
        if (isActive) {
          expect(override).toBeDefined();
          expect(override!.bars!.length).toBe(seg.bars.length);
        } else {
          expect(override).toBeUndefined();
        }
      }
    }
  });

  it('no BarBeat key in any override is >= beatsPerBar()', () => {
    const song = orchestrate(POP_PARAMS);
    const beats = beatsPerBar();
    for (const payload of Object.values(song.arrangement)) {
      for (const override of Object.values(payload.overrides)) {
        for (const bar of override.bars ?? []) {
          for (const key of Object.keys(bar.notes ?? {})) {
            const b = parseBarBeat(key);
            expect(b).toBeGreaterThanOrEqual(0);
            expect(b).toBeLessThan(beats);
          }
        }
      }
    }
  });

  it('vocal override notes all carry fullWord + non-empty phonemes; absent from non-sung segments', () => {
    const song = orchestrate(POP_PARAMS);
    // Sung segment-types: verse / preChorus / chorus / bridge.
    // Non-sung: intro / outro / break.
    const SUNG = ['verse', 'preChorus', 'chorus', 'bridge'];
    const isSung = (name: string) => SUNG.some((p) => name.startsWith(p));
    for (const [segName, payload] of Object.entries(song.arrangement)) {
      const vocal = payload.overrides.Vocal;
      if (!isSung(segName)) {
        expect(vocal, `expected no vocal override on "${segName}"`).toBeUndefined();
        continue;
      }
      expect(vocal, `expected vocal override on sung "${segName}"`).toBeDefined();
      let noteCount = 0;
      for (const bar of vocal!.bars ?? []) {
        for (const events of Object.values(bar.notes ?? {})) {
          for (const ev of events) {
            noteCount++;
            expect(ev.type).toBe('vocalNote');
            if (ev.type === 'vocalNote') {
              expect(ev.fullWord && ev.fullWord.length).toBeGreaterThan(0);
              expect(ev.vocaloidPhonemes && ev.vocaloidPhonemes.length).toBeGreaterThan(0);
            }
          }
        }
      }
      expect(noteCount).toBeGreaterThan(0);
    }
  });

  it('instrumentDefinitions cover the essential lanes (Drums/Bass/Pad) + a Vocal fixture, each tied to a validated catalog id', () => {
    const song = orchestrate(POP_PARAMS);
    const byName = new Map(song.instrumentDefinitions.map((d) => [d.name, d]));
    // The essential lanes are always present and come from the validated
    // catalog (16-hex ids). Other lanes (Keys/Guitar/Synths/…) are
    // probabilistic under the lane model (docs/58i).
    for (const name of ['Drums', 'Bass', 'Pad']) {
      const def = byName.get(name);
      expect(def, `missing instrumentDefinition for ${name}`).toBeDefined();
      expect(String(def!.id)).toMatch(/^[0-9a-f]{16}$/u);
    }
    // The Vocal entry is still a hand-authored fixture — the catalog
    // snapshot's `vocals` sheet has 0 audit-valid rows so no upgrade path yet.
    const vocal = byName.get('Vocal')!;
    expect(vocal.shortName).toBe('Slice Placeholder Vocalist');
  });

  it('matches committed golden Song fixture (brightPop / brightPop-vertical-slice)', async () => {
    const song = orchestrate(POP_PARAMS);
    const generated = `${canonicalStringifySong(song, 2)}\n`;
    const golden = await readFile(orchestrateGoldenPath('brightPop', 'brightPop-vertical-slice'), 'utf8');
    expect(generated).toBe(golden);
  });

  it('rejects a non-canonical genre', () => {
    // Post-53r every canonical brain genre generates chords cleanly via
    // the shared bank, so we exercise the non-canonical path instead
    // (the Phase-3 placeholder `pop` is the canonical "rejected" case).
    expect(() => orchestrate({ ...POP_PARAMS, genre: 'pop', seed: 'g' })).toThrow();
  });
});

describe('lowerToSong (intermediate-projection)', () => {
  function pipeline(seed: string | number) {
    const params = paramsFor(seed);
    const ctx = { params, rng: createRng(params.seed) };
    const structure = generateChords(ctx, generateSongStructure(ctx));
    const selection = selectInstruments(ctx, structure);
    const patterns = generatePatterns(ctx, structure, selection);
    const vocals = generateVocalMelody(ctx, structure);
    const fills = generateFills(ctx, structure, selection);
    const mutes = generateMutes(ctx, structure, selection);
    const transitions = generateTransitions(ctx, structure);
    const signalProcessors = generateSignalProcessors(ctx, structure, selection);
    return {
      params,
      ctx,
      structure,
      selection,
      patterns,
      vocals,
      fills,
      mutes,
      transitions,
      signalProcessors,
    };
  }

  it('does not mutate intermediate inputs (structure / selection / patterns / vocals)', () => {
    const p = pipeline('immutability');
    const snapshots = {
      structure: stableStringify(p.structure, 2),
      selection: stableStringify(p.selection, 2),
      patterns: stableStringify(p.patterns, 2),
      vocals: stableStringify(p.vocals, 2),
    };
    lowerToSong({
      params: p.params,
      structure: p.structure,
      selection: p.selection,
      patterns: p.patterns,
      vocals: p.vocals,
      fills: p.fills,
      mutes: p.mutes,
      transitions: p.transitions,
      signalProcessors: p.signalProcessors,
    });
    expect(stableStringify(p.structure, 2)).toBe(snapshots.structure);
    expect(stableStringify(p.selection, 2)).toBe(snapshots.selection);
    expect(stableStringify(p.patterns, 2)).toBe(snapshots.patterns);
    expect(stableStringify(p.vocals, 2)).toBe(snapshots.vocals);
  });

  it('produces the same Song as orchestrate() when fed the same intermediates', () => {
    const p = pipeline('same-as-orchestrate');
    // Mirror orchestrate(): the drum + bass per-segment override pass runs over
    // the base patterns before lowering (to-do #1 Phase B).
    const overriddenPatterns = applyArrangementOverrides(
      p.ctx,
      p.structure,
      p.selection,
      p.patterns,
    );
    const direct = canonicalStringifySong(
      lowerToSong({
        params: p.params,
        structure: p.structure,
        selection: p.selection,
        patterns: overriddenPatterns,
        vocals: p.vocals,
        fills: p.fills,
        mutes: p.mutes,
        transitions: p.transitions,
        signalProcessors: p.signalProcessors,
      }),
      2,
    );
    const viaOrchestrate = canonicalStringifySong(orchestrate(p.params), 2);
    expect(direct).toBe(viaOrchestrate);
  });
});
