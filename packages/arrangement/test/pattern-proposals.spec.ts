// Pattern lab proposals: loading/validation, previews, authored generators.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createRng } from '@casperaki/music-theory';

import { orchestrate } from '../src/index.js';
import { AUTHORED_DRUM_ALGOS } from '../src/patterns/drums-authored.js';
import { selectPreviewDrumBlueprint } from '../src/patterns/drums-bank.js';
import { drumPreviewFromParams, loadPatternProposals, previewParamsFor } from '../src/patterns/proposals.js';
import { generateAlgoBlueprint } from '../src/patterns/drums-algo.js';

const tmpProposals = (content: unknown) => {
  const dir = mkdtempSync(join(tmpdir(), 'proposals-'));
  writeFileSync(join(dir, 'a.json'), JSON.stringify(content));
  return dir;
};
const base = { family: 'drums', name: 'n', genres: ['latin'], rationale: 'r' };

describe('pattern proposals', () => {
  it('a bass preview plays its pattern in every section (no arrangement override replaces it)', () => {
    const p = loadPatternProposals().find((x) => x.id === 'urban-rnb-bass');
    if (!p || p.kind !== 'bassPatterns') throw new Error('urban-rnb-bass proposal missing');
    const song = orchestrate({ genre: 'urban', key: 'C', bpm: 90, seed: 'pattern-lab-urban-rnb-bass-urban', params: previewParamsFor(p, 0) });
    const onsets = new Set(p.patterns[0]!.map(([beat]) => beat));
    for (const seg of song.songStructure) {
      const bars = song.arrangement[seg.name]!.overrides.Bass?.bars ?? [];
      bars.forEach((bar, i) => {
        for (const beat of Object.keys(bar.notes)) expect(onsets, `${seg.name} bar ${i} beat ${beat}`).toContain((i % 2) * 4 + Number(beat));
      });
    }
  });

  it('loads the committed proposals', () => {
    const ps = loadPatternProposals();
    expect(ps.length).toBeGreaterThan(0);
    expect(new Set(ps.map((p) => p.id)).size).toBe(ps.length);
  });

  it('rejects unknown lanes, unknown generators and duplicate ids', () => {
    expect(() => loadPatternProposals(tmpProposals([{ ...base, id: 'x', kind: 'blueprints', blueprints: [{ cowbell: [0] }] }]))).toThrow(/unknown lane "cowbell"/);
    expect(() => loadPatternProposals(tmpProposals([{ ...base, id: 'x', kind: 'algo', algo: 'nope' }]))).toThrow(/unknown generator "nope"/);
    const one = { ...base, id: 'x', kind: 'blueprints', blueprints: [{ bassDrum1: [0] }] };
    expect(() => loadPatternProposals(tmpProposals([one, one]))).toThrow(/duplicate proposal id/);
  });

  it('a preview puts the proposal into the song, deterministically', () => {
    const p = loadPatternProposals().find((x) => x.kind === 'blueprints')!;
    const params = { genre: p.genres[0]!, key: 'C', bpm: 100, seed: 'preview-test' };
    const withP = orchestrate({ ...params, params: previewParamsFor(p) });
    const again = orchestrate({ ...params, params: previewParamsFor(p) });
    const current = orchestrate(params);
    expect(JSON.stringify(withP)).toBe(JSON.stringify(again));
    expect(JSON.stringify(withP.arrangement)).not.toBe(JSON.stringify(current.arrangement));
  });

  it('previewed blueprints come from the proposal', () => {
    const blueprints = [{ bassDrum1: [0, 2], snareDrum1: [1, 3] }];
    const sel = selectPreviewDrumBlueprint(createRng(1), { kind: 'blueprints', blueprints });
    expect(sel.blueprint).toEqual(blueprints[0]);
    expect(() => drumPreviewFromParams({ drumPreview: { kind: 'blueprints', blueprints: [] } })).toThrow(/invalid drumPreview/);
  });

  it('authored generators are deterministic and stay on the grid', () => {
    for (const [name, gen] of Object.entries(AUTHORED_DRUM_ALGOS)) {
      const pick = () => ({});
      const a = gen(createRng(`${name}-1`), pick);
      expect(gen(createRng(`${name}-1`), pick)).toEqual(a);
      for (const positions of Object.values(a)) {
        for (const pos of positions) {
          expect(pos).toBeGreaterThanOrEqual(0);
          expect(pos).toBeLessThan(8);
          expect(Number.isInteger(pos * 8)).toBe(true);
        }
      }
    }
    // Legacy generators untouched by the authored registry.
    expect(generateAlgoBlueprint(createRng(7), 'urban', () => ({}))).toEqual(generateAlgoBlueprint(createRng(7), 'urban', () => ({})));
  });

  it('a bass preview plays the proposed chord-relative line', () => {
    const p = loadPatternProposals().find((x) => x.kind === 'bassPatterns')!;
    const params = { genre: p.genres[0]!, key: 'C', bpm: 120, seed: 'bass-preview' };
    const song = orchestrate({ ...params, params: previewParamsFor(p) });
    const again = orchestrate({ ...params, params: previewParamsFor(p) });
    expect(JSON.stringify(song)).toBe(JSON.stringify(again));
    expect(JSON.stringify(song.arrangement)).not.toBe(JSON.stringify(orchestrate(params).arrangement));
    expect(() => loadPatternProposals(tmpProposals([{ ...base, family: 'bass', id: 'b', kind: 'bassPatterns', patterns: [[[0, 1, 40]]] }]))).toThrow();
  });
});
