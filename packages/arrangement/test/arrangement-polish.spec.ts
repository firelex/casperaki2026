// Step 16 — arrangement polish (fills / mutes / transitions / signal
// processors). See docs/53aa-step16-arrangement-polish-import.md.

import { describe, expect, it } from 'vitest';

import { createRng } from '@casperaki/music-theory';

import {
  _resetArrangementPolishCache,
  generateChords,
  generateFills,
  generateMutes,
  generatePatterns,
  generateSignalProcessors,
  generateSongStructure,
  generateTransitions,
  isTransitionAnchorSegment,
  loadArrangementRules,
  loadFillBank,
  orchestrate,
  segmentType,
  selectInstruments,
  type GenerateParams,
  type GeneratorContext,
} from '../src/index.js';

const POP_PARAMS: GenerateParams = {
  genre: 'brightPop',
  key: 'C',
  bpm: 120,
  seed: 'brightPop-vertical-slice',
};

function makeCtx(seed: string | number): GeneratorContext {
  const params: GenerateParams = { genre: 'brightPop', key: 'C', bpm: 120, seed };
  return { params, rng: createRng(params.seed) };
}

function pipeline(seed: string | number) {
  const ctx = makeCtx(seed);
  const structure = generateChords(ctx, generateSongStructure(ctx));
  const selection = selectInstruments(ctx, structure);
  // Pattern generation isn't required for fills/transitions/SP — they don't
  // read from PatternResult — but running it keeps the fork salts ordered
  // the way orchestrate() runs them.
  generatePatterns(ctx, structure, selection);
  return { ctx, structure, selection };
}

describe('arrangement polish — segment-type helper', () => {
  it('extracts canonical segment-type prefix from camelCase names', () => {
    expect(segmentType('intro')).toBe('intro');
    expect(segmentType('verse1')).toBe('verse');
    expect(segmentType('verse10')).toBe('verse');
    expect(segmentType('preChorus2')).toBe('preChorus');
    expect(segmentType('chorus3')).toBe('chorus');
    expect(segmentType('bridge1')).toBe('bridge');
    expect(segmentType('break1')).toBe('break');
    expect(segmentType('outro')).toBe('outro');
  });

  it('isTransitionAnchorSegment matches legacy "first instance + head + tail" rule', () => {
    expect(isTransitionAnchorSegment('intro')).toBe(true);
    expect(isTransitionAnchorSegment('outro')).toBe(true);
    expect(isTransitionAnchorSegment('verse1')).toBe(true);
    expect(isTransitionAnchorSegment('chorus10')).toBe(true);
    expect(isTransitionAnchorSegment('verse2')).toBe(false);
    expect(isTransitionAnchorSegment('chorus2')).toBe(false);
  });
});

describe('loadArrangementRules / loadFillBank manifests', () => {
  it('rules manifest declares fills/transitions/signalProcessors entries for every legacy segment-type', () => {
    _resetArrangementPolishCache();
    const rules = loadArrangementRules();
    // The fill-style genre list pulls straight from legacy drums.js's brightPop
    // fill-eligible style set.
    expect(rules.fillStylesByGenre).toContain('brightPop');
    expect(rules.fills.verse).toBeDefined();
    expect(rules.fills.preChorus).toBeDefined();
    expect(rules.fills.chorus).toBeDefined();
    expect(rules.transitions.intro).toBeDefined();
    expect(rules.transitions.chorus).toBeDefined();
    expect(rules.transitions.bridge).toBeDefined();
    expect(rules.signalProcessors.break.length).toBeGreaterThan(0);
    expect(rules.signalProcessors.bridge.length).toBeGreaterThan(0);
    // Brightpop SP pool includes the constant lowPassFilter tag at weight 3 (legacy 3x repeat).
    const brk = rules.signalProcessors.break.find((c) => c.type === 'lowPassFilter');
    expect(brk?.weight).toBe(3);
  });

  it('fill bank carries small/medium/big categories with edm + default style branches', () => {
    _resetArrangementPolishCache();
    const bank = loadFillBank();
    expect(bank.gridLength).toBe(32);
    for (const cat of ['smallFill', 'mediumFill', 'bigFill'] as const) {
      for (const branch of ['edm', 'default'] as const) {
        const pool = bank.categories[cat][branch];
        expect(pool.length, `${cat}.${branch} empty`).toBeGreaterThan(0);
        for (const variant of pool) {
          expect(variant.steps.length).toBeGreaterThan(0);
          for (const step of variant.steps) {
            if ('add' in step) {
              expect(step.add.lanes.length).toBeGreaterThan(0);
              for (const g of step.add.grids) expect(g).toMatch(/^[x\-0\s]+$/u);
            } else {
              expect(step.choice.count).toBeGreaterThan(0);
              for (const adds of Object.values(step.choice.cases)) {
                for (const add of adds) {
                  expect(add.lanes.length).toBeGreaterThan(0);
                  for (const g of add.grids) expect(g).toMatch(/^[x\-0\s]+$/u);
                }
              }
            }
          }
        }
      }
    }
    // EDM branch is clap-only (legacy switch 0-4); composeFrom only on bigFill.
    for (const cat of ['smallFill', 'mediumFill', 'bigFill'] as const) {
      for (const v of bank.categories[cat].edm) {
        for (const step of v.steps) {
          if ('add' in step) expect(step.add.lanes).toContain('clap');
        }
      }
    }
    expect(bank.categories.bigFill.default.some((v) => v.composeFrom === 'mediumFill')).toBe(true);
  });

  it('cache reset is a no-op (rules load idempotently)', () => {
    const a = loadArrangementRules();
    _resetArrangementPolishCache();
    const b = loadArrangementRules();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('generateFills', () => {
  it('produces a FillBlock for every drums-active segment in brightPop-vertical-slice', () => {
    const p = pipeline('brightPop-vertical-slice');
    const result = generateFills(p.ctx, p.structure, p.selection);
    const drumsActive = new Set(
      p.selection.segments
        .filter((s) => s.activeLanes.includes('Drums'))
        .map((s) => s.segmentName),
    );
    const withFills = new Set(Object.keys(result.bySegment));
    expect(drumsActive.size).toBeGreaterThan(0);
    expect(withFills.size).toBeGreaterThan(0);
    for (const name of withFills) {
      expect(drumsActive.has(name)).toBe(true);
    }
  });

  it('inactive instruments do not receive fills (drums-inactive segments are absent)', () => {
    const p = pipeline('brightPop-vertical-slice');
    const result = generateFills(p.ctx, p.structure, p.selection);
    const drumsInactive = p.selection.segments
      .filter((s) => !s.activeLanes.includes('Drums'))
      .map((s) => s.segmentName);
    for (const name of drumsInactive) {
      expect(result.bySegment[name]).toBeUndefined();
    }
  });

  it('every emitted fill carries patterns and at least one lane grid', () => {
    const p = pipeline('brightPop-vertical-slice');
    const result = generateFills(p.ctx, p.structure, p.selection);
    for (const block of Object.values(result.bySegment)) {
      const drumsBlock = block.Drums!;
      expect(drumsBlock).toBeDefined();
      expect(drumsBlock.reset).toBe(false);
      expect(drumsBlock.patterns).toBeDefined();
      const slots = Object.keys(drumsBlock.patterns!);
      expect(slots.length).toBeGreaterThan(0);
      for (const slot of slots) {
        const grids = drumsBlock.patterns![slot]!;
        const lanes = Object.keys(grids);
        expect(lanes.length).toBeGreaterThan(0);
        for (const lane of lanes) {
          const g = grids[lane]!;
          // Whitespace stripped + only x/-/0 characters.
          expect(g).toMatch(/^[x\-0]+$/u);
        }
      }
    }
  });

  it('same seed → byte-identical fills output', () => {
    const a = pipeline('seed-determinism');
    const b = pipeline('seed-determinism');
    const ra = generateFills(a.ctx, a.structure, a.selection);
    const rb = generateFills(b.ctx, b.structure, b.selection);
    expect(JSON.stringify(ra)).toBe(JSON.stringify(rb));
  });

  it('different seeds → different fills (legacy rules carry alternatives)', () => {
    const a = pipeline('seed-variance-1');
    const b = pipeline('seed-variance-2');
    const ra = generateFills(a.ctx, a.structure, a.selection);
    const rb = generateFills(b.ctx, b.structure, b.selection);
    expect(JSON.stringify(ra)).not.toBe(JSON.stringify(rb));
  });
});

// docs/06-16 to-do #4 — fill variant breadth + EDM/non-EDM style branch.
describe('generateFills — EDM vs non-EDM style branch (to-do #4)', () => {
  function pipelineFor(genre: string, seed: string) {
    const params: GenerateParams = { genre, key: 'C', bpm: 120, seed };
    const ctx: GeneratorContext = { params, rng: createRng(seed) };
    const structure = generateChords(ctx, generateSongStructure(ctx));
    const selection = selectInstruments(ctx, structure);
    generatePatterns(ctx, structure, selection);
    return { ctx, structure, selection };
  }

  /** Every lane grid emitted by any fill, across N seeds for a genre. */
  function lanesAcrossSeeds(genre: string, n = 24): Set<string> {
    const lanes = new Set<string>();
    for (let i = 0; i < n; i++) {
      const p = pipelineFor(genre, `${genre}-fill-${i}`);
      const result = generateFills(p.ctx, p.structure, p.selection);
      for (const block of Object.values(result.bySegment)) {
        for (const grids of Object.values(block.Drums!.patterns!)) {
          for (const lane of Object.keys(grids)) lanes.add(lane);
        }
      }
    }
    return lanes;
  }

  for (const genre of ['edm', 'brightPop', 'schlager']) {
    it(`EDM-branch genre "${genre}" emits clap-only fills (legacy switch 0-4)`, () => {
      const lanes = lanesAcrossSeeds(genre);
      expect(lanes.size).toBeGreaterThan(0);
      expect([...lanes]).toEqual(['clap']);
    });
  }

  // Only the non-EDM genres that legacy actually rolls fills for
  // (rules.json#fillStylesByGenre — ballad/urban are absent → no fills).
  for (const genre of ['latin', 'rock', 'organicVibes']) {
    it(`non-EDM genre "${genre}" emits kit fills (snare/tom/kick), never clap`, () => {
      const lanes = lanesAcrossSeeds(genre);
      expect(lanes.size).toBeGreaterThan(0);
      expect(lanes.has('clap')).toBe(false);
      // The non-EDM banks always involve the snare; toms/kick show up in the
      // medium/big variants.
      expect(lanes.has('snareDrum1') || lanes.has('snareDrum2')).toBe(true);
    });
  }

  it('EDM clap fills carry the legacy beat offset (hits start mid-bar, not at slot 0)', () => {
    // Legacy overlays the clap grid at slot (4+beat)*8 with beat ∈ {-1,-2}
    // and the grid itself opens `0000x…`; the first hit therefore lands well
    // into the bar (slot 20 for beat -2, slot 28 for beat -1) — never slot 0.
    const p = pipelineFor('edm', 'edm-clap-offset');
    const result = generateFills(p.ctx, p.structure, p.selection);
    let inspected = 0;
    for (const block of Object.values(result.bySegment)) {
      for (const grids of Object.values(block.Drums!.patterns!)) {
        const clap = grids['clap'];
        if (!clap) continue;
        expect(clap[0]).not.toBe('x');
        expect(clap.indexOf('x')).toBeGreaterThanOrEqual(16);
        inspected++;
      }
    }
    expect(inspected).toBeGreaterThan(0);
  });

  it('bigFill expandMiddleFill composes a mediumFill underneath the intro', () => {
    // A non-EDM bigFill that took the expandMiddleFill branch carries lanes
    // from BOTH the mediumFill (snare/tom on beat 3) and the fill intro
    // (earlier-bar kick/snare). Scan rock (default branch, bigFill on chorus).
    const seen = { snareDrum1: false, bassDrum1: false };
    for (let i = 0; i < 60; i++) {
      const p = pipelineFor('rock', `rock-bigfill-${i}`);
      const result = generateFills(p.ctx, p.structure, p.selection);
      for (const block of Object.values(result.bySegment)) {
        for (const grids of Object.values(block.Drums!.patterns!)) {
          // A composed bigFill reaches back to slot 0 on the kick (intro) and
          // also has snare content — i.e. a long, multi-lane grid.
          if (grids['bassDrum1']) seen.bassDrum1 = true;
          if (grids['snareDrum1']) seen.snareDrum1 = true;
        }
      }
      if (seen.bassDrum1 && seen.snareDrum1) break;
    }
    expect(seen.snareDrum1).toBe(true);
    expect(seen.bassDrum1).toBe(true);
  });
});

describe('generateTransitions', () => {
  it('main transitions land on anchors; B4 post-passes may add fxNoiseRise/cymbalsCrashHit elsewhere', () => {
    // docs/62 B4 — the cross-segment post-passes inject fxNoiseRise before a
    // chorus and cymbalsCrashHit after an fxReverse, which can land on
    // non-anchor segments. Any non-anchor entry must therefore carry ONLY those
    // two post-pass tags.
    const POST_PASS_TAGS = new Set(['fxNoiseRise', 'cymbalsCrashHit']);
    const p = pipeline('brightPop-vertical-slice');
    const result = generateTransitions(p.ctx, p.structure);
    for (const [name, block] of Object.entries(result.bySegment)) {
      if (isTransitionAnchorSegment(name)) continue;
      for (const tag of Object.keys(block)) {
        expect(POST_PASS_TAGS.has(tag), `${name} has non-post-pass tag "${tag}"`).toBe(true);
      }
    }
  });

  it('emits at least one transition for brightPop intro / verse1 / chorus1', () => {
    const p = pipeline('brightPop-vertical-slice');
    const result = generateTransitions(p.ctx, p.structure);
    const segmentNames = new Set(p.structure.map((s) => s.name));
    if (segmentNames.has('intro')) {
      const block = result.bySegment.intro;
      expect(block).toBeDefined();
      expect(Object.keys(block!).length).toBeGreaterThan(0);
    }
    if (segmentNames.has('chorus1')) {
      const block = result.bySegment.chorus1;
      expect(block).toBeDefined();
      expect(Object.keys(block!).length).toBeGreaterThan(0);
    }
  });

  it('chorus transitions include cymbalsCrashHit (legacy brightPop extra-always)', () => {
    const p = pipeline('brightPop-vertical-slice');
    const result = generateTransitions(p.ctx, p.structure);
    if (result.bySegment.chorus1) {
      expect(result.bySegment.chorus1.cymbalsCrashHit).toBeDefined();
    }
  });

  it('each transition entry carries a string `type` and a placement tag', () => {
    const p = pipeline('brightPop-vertical-slice');
    const result = generateTransitions(p.ctx, p.structure);
    for (const block of Object.values(result.bySegment)) {
      for (const entry of Object.values(block)) {
        const e = entry as { type: unknown; placement: unknown };
        expect(typeof e.type).toBe('string');
        expect(['beginningOfSegment', 'midSegment', 'endOfSegment']).toContain(e.placement);
      }
    }
  });

  it('same seed → byte-identical transitions', () => {
    const a = pipeline('transitions-determinism');
    const b = pipeline('transitions-determinism');
    expect(JSON.stringify(generateTransitions(a.ctx, a.structure))).toBe(
      JSON.stringify(generateTransitions(b.ctx, b.structure)),
    );
  });

  it('different seeds → different transition picks (legacy pools have alternatives)', () => {
    const a = pipeline('transitions-variance-1');
    const b = pipeline('transitions-variance-2');
    expect(JSON.stringify(generateTransitions(a.ctx, a.structure))).not.toBe(
      JSON.stringify(generateTransitions(b.ctx, b.structure)),
    );
  });

  // edmSnareDrumRoll is a TransitionPattern: the brain attaches its generated
  // snare-roll grid to the entry (docs/54n; engine TransitionPattern.h).
  // A bridge anchor always rolls (rules.json bridge.endAnyGenre =
  // ['edmSnareDrumRoll']), so we hand-build a minimal structure to exercise it.
  function structureWith(segments: ReadonlyArray<{ name: string; barCount: number }>) {
    return segments.map((s) => ({
      name: s.name,
      bars: Array.from({ length: s.barCount }, () => ({ chords: ['C'] })),
    })) as unknown as Parameters<typeof generateTransitions>[1];
  }

  it('attaches a snare-roll pattern + lengthInBars to the edmSnareDrumRoll entry', () => {
    const ctx = makeCtx('edm-snare-roll');
    const structure = structureWith([{ name: 'bridge1', barCount: 4 }]);
    const result = generateTransitions(ctx, structure);
    const entry = result.bySegment.bridge1?.edmSnareDrumRoll as
      | { type: string; placement: string; pattern?: Record<string, string>; lengthInBars?: number }
      | undefined;
    expect(entry).toBeDefined();
    expect(entry!.type).toBe('edmSnareDrumRoll');
    expect(entry!.lengthInBars).toBe(4);
    expect(entry!.pattern).toBeDefined();
    const snare1 = entry!.pattern!.snareDrum1;
    expect(typeof snare1).toBe('string');
    // Grid, stripped to engine-relevant 0/x steps, is exactly lengthInBars*32.
    expect(snare1!.replace(/[^0x]/gu, '').length).toBe(4 * 32);
    expect(snare1).toMatch(/x/u); // a roll has at least one hit
  });

  it('non-edmSnareDrumRoll entries carry no pattern field', () => {
    const ctx = makeCtx('edm-snare-roll');
    const structure = structureWith([{ name: 'bridge1', barCount: 4 }]);
    const result = generateTransitions(ctx, structure);
    for (const [tag, entry] of Object.entries(result.bySegment.bridge1 ?? {})) {
      if (tag === 'edmSnareDrumRoll') continue;
      expect((entry as { pattern?: unknown }).pattern).toBeUndefined();
    }
  });

  it('snare-roll grid is generated on a separate fork, capped at min(bars, 4)', () => {
    // docs/62 B4 — the bridge snare roll is now a 50% coin (legacy :219), so
    // scan seeds until one rolls, then confirm the grid length is capped at the
    // segment bar count (proves the roll uses the segment, on its own fork).
    let checked = false;
    for (let i = 0; i < 32 && !checked; i++) {
      const ctx = makeCtx(`edm-snare-roll-${i}`);
      const structure = structureWith([
        { name: 'verse1', barCount: 8 },
        { name: 'bridge1', barCount: 2 },
      ]);
      const entry = generateTransitions(ctx, structure).bySegment.bridge1?.edmSnareDrumRoll as
        | { lengthInBars?: number }
        | undefined;
      if (!entry) continue;
      expect(entry.lengthInBars).toBe(2); // cappedBars = min(2, 4)
      checked = true;
    }
    expect(checked, 'expected at least one seed to roll the bridge snare').toBe(true);
  });
});

describe('generateSignalProcessors', () => {
  it('emits a Drums SignalProcessorBlock for every break/bridge segment in the structure', () => {
    const p = pipeline('brightPop-vertical-slice');
    const result = generateSignalProcessors(p.ctx, p.structure, p.selection);
    const breakBridgeSegments = p.structure
      .filter((s) => {
        const t = segmentType(s.name);
        return t === 'break' || t === 'bridge';
      })
      .map((s) => s.name);
    expect(breakBridgeSegments.length).toBeGreaterThan(0);
    for (const name of breakBridgeSegments) {
      const block = result.bySegment[name];
      expect(block).toBeDefined();
      expect(block!.Drums).toBeDefined();
      expect(typeof block!.Drums.type).toBe('string');
      expect(block!.Drums.type!.startsWith('lowPassFilter')).toBe(true);
    }
  });

  it('only break/bridge (Drums SP) and intro/verse1/preChorus/outro (song-wide effects) ever get SP', () => {
    // verse2 / chorus / etc. must never carry a signalProcessor entry.
    for (let i = 0; i < 24; i++) {
      const p = pipeline(`sp-eligible-${i}`);
      const result = generateSignalProcessors(p.ctx, p.structure, p.selection);
      for (const seg of p.structure) {
        const t = segmentType(seg.name);
        const eligible =
          t === 'break' || t === 'bridge' || t === 'intro' || t === 'preChorus' ||
          t === 'outro' || seg.name === 'verse1';
        if (!eligible) {
          expect(result.bySegment[seg.name], `${seg.name} unexpectedly has SP`).toBeUndefined();
        }
      }
    }
  });

  it('song-wide effects apply across ALL active (non-vocal) lanes of the segment (to-do #8)', () => {
    // Scan brightPop seeds until a song-wide effect fires on an intro/verse1/
    // preChorus/outro, then confirm every active lane in that segment carries
    // the same effect tag.
    const VOCAL_LANES = new Set(['Vocal', 'Backing vocals 1', 'Backing vocals 2']);
    let proven = false;
    for (let i = 0; i < 120 && !proven; i++) {
      const p = pipeline(`sp-songwide-${i}`);
      const sp = generateSignalProcessors(p.ctx, p.structure, p.selection);
      const activeByName = new Map(
        p.selection.segments.map((s) => [s.segmentName, s.activeLanes]),
      );
      for (const seg of p.structure) {
        const t = segmentType(seg.name);
        const isEffectSeg =
          t === 'intro' || t === 'preChorus' || t === 'outro' || seg.name === 'verse1';
        if (!isEffectSeg) continue;
        const block = sp.bySegment[seg.name];
        if (!block) continue;
        const active = (activeByName.get(seg.name) ?? []).filter((l) => !VOCAL_LANES.has(l));
        if (active.length < 2) continue;
        // Every active lane carries the same effect tag (fade* / lowPass*).
        const tags = active.map((l) => block[l]?.type);
        expect(tags.every((tg) => typeof tg === 'string')).toBe(true);
        expect(new Set(tags).size).toBe(1);
        expect(/^(fadeIn|fadeOut|lowPassFilter)/u.test(tags[0]!)).toBe(true);
        proven = true;
        break;
      }
    }
    expect(proven, 'no brightPop seed produced a song-wide effect in 120 tries').toBe(true);
  });

  it('outroEffect (fadeOut) only rolls for fade genres; rock never gets an intro fadeIn', () => {
    // rock is excluded from FADE_GENRES → no fadeIn/fadeOut ever.
    for (let i = 0; i < 40; i++) {
      const params: GenerateParams = { genre: 'rock', key: 'C', bpm: 120, seed: `rock-fade-${i}` };
      const ctx: GeneratorContext = { params, rng: createRng(`rock-fade-${i}`) };
      const structure = generateChords(ctx, generateSongStructure(ctx));
      const selection = selectInstruments(ctx, structure);
      const sp = generateSignalProcessors(ctx, structure, selection);
      for (const block of Object.values(sp.bySegment)) {
        for (const b of Object.values(block)) {
          if (typeof b.type === 'string') {
            expect(b.type.startsWith('fade')).toBe(false);
          }
        }
      }
    }
  });

  it('weighted picks favour lowPassFilter for break across many seeds (legacy weight 3:1:1:1:1:1)', () => {
    let lowPass = 0;
    let other = 0;
    for (let i = 0; i < 80; i++) {
      const p = pipeline(`sp-distribution-${i}`);
      const result = generateSignalProcessors(p.ctx, p.structure, p.selection);
      for (const seg of p.structure) {
        if (segmentType(seg.name) !== 'break') continue;
        const tag = result.bySegment[seg.name]?.Drums?.type;
        if (tag === 'lowPassFilter') lowPass++;
        else if (typeof tag === 'string') other++;
      }
    }
    // Pool is 8 entries; lowPassFilter accounts for 3/8 of picks. Loosely
    // assert it's the modal pick across 80 trials.
    expect(lowPass).toBeGreaterThan(0);
    if (other > 0) expect(lowPass / other).toBeGreaterThan(0.2);
  });

  it('same seed → byte-identical signalProcessors output', () => {
    const a = pipeline('sp-determinism');
    const b = pipeline('sp-determinism');
    expect(JSON.stringify(generateSignalProcessors(a.ctx, a.structure, a.selection))).toBe(
      JSON.stringify(generateSignalProcessors(b.ctx, b.structure, b.selection)),
    );
  });
});

describe('generateMutes (deferred — empty per legacy dead-code)', () => {
  it('returns no entries today (legacy mute branch is dead code)', () => {
    const p = pipeline('mutes-empty');
    const result = generateMutes(p.ctx, p.structure, p.selection);
    expect(Object.keys(result.bySegment)).toEqual([]);
  });

  it('still forks the mutes salt up-front (claims the RNG name)', () => {
    // Forking through generateMutes must not change downstream salt
    // behaviour because forks are independent streams.
    const a = pipeline('mutes-fork-1');
    const before = generateSignalProcessors(a.ctx, a.structure, a.selection);
    const b = pipeline('mutes-fork-1');
    generateMutes(b.ctx, b.structure, b.selection);
    const after = generateSignalProcessors(b.ctx, b.structure, b.selection);
    expect(JSON.stringify(before)).toBe(JSON.stringify(after));
  });
});

describe('cross-family fork-salt independence (orchestrate)', () => {
  it('orchestrate result still has Drums override on chorus1 and Bass override on verse1', () => {
    // Pin that the new side-block generators do not shift the pattern
    // streams: the per-family overrides remain intact.
    const song = orchestrate(POP_PARAMS);
    const chorus1 = song.arrangement.chorus1!;
    expect(chorus1.overrides.Drums).toBeDefined();
    const verse1 = song.arrangement.verse1!;
    expect(verse1.overrides.Bass).toBeDefined();
  });

  it('brightPop orchestrate emits non-empty fills + transitions + signalProcessors blocks somewhere', () => {
    const song = orchestrate(POP_PARAMS);
    const fillsNonEmpty = Object.values(song.arrangement).some(
      (s) => Object.keys(s.fills).length > 0,
    );
    const transitionsNonEmpty = Object.values(song.arrangement).some(
      (s) => Object.keys(s.transitions).length > 0,
    );
    const spNonEmpty = Object.values(song.arrangement).some(
      (s) => Object.keys(s.signalProcessors).length > 0,
    );
    expect(fillsNonEmpty).toBe(true);
    expect(transitionsNonEmpty).toBe(true);
    expect(spNonEmpty).toBe(true);
  });
});
