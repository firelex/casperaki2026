// Genre recipes in the generator (docs/superpowers/specs/2026-11-28-genre-recipes-design.md): Casperaki Pop is
// generated as Bright Pop with Dr. Luke drums, an electric guitar in every section and hip-hop drums in the verses.
import { describe, expect, it } from 'vitest';
import { GENRE_RECIPES } from '@casperaki/song-schema';

import { createRng } from '@casperaki/music-theory';
import { drumKit, generateDrumPattern, generatorParams, orchestrate, selectDrumBlueprint } from '../src/index.js';
import { selectVirtualGuitaristPattern } from '../src/patterns/virtual-guitarist-bank.js';
import { drumStylesFor } from '../src/patterns/drums.js';

const ELECTRIC_CLEAN = ['electricGuitarsDominoStereo', 'electricGuitarsLpChorusStereo'];
const song = orchestrate({ genre: 'casperakiPop', key: 'C', bpm: 110, seed: 'casperaki-pop' });

describe('Casperaki Pop', () => {
  it('keeps its genre on the song and in its generator params (regenerating replays the recipe)', () => {
    expect(song.genre).toBe('casperakiPop');
    expect((song.generator!.params as { genre: string }).genre).toBe('casperakiPop');
    const again = orchestrate(generatorParams(song));
    expect(again.arrangement).toEqual(song.arrangement);
  });

  it('a clean electric guitar plays in every section', () => {
    const guitar = song.instrumentDefinitions.find((d) => ELECTRIC_CLEAN.includes(String(d.lowLevelType)));
    expect(guitar, JSON.stringify(song.instrumentDefinitions.map((d) => [d.name, d.lowLevelType]))).toBeDefined();
    for (const s of song.songStructure) expect(Object.keys(song.arrangement[s.name]!.overrides), s.name).toContain(guitar!.name);
  });

  it('its kick, snare and clap are Dr. Luke samples; the rest of the kit is Bright Pop\'s', () => {
    const kit = drumKit('casperakiPop');
    for (const role of ['bassDrum1', 'bassDrum2', 'snareDrum1', 'snareDrum2', 'clap', 'snap']) {
      expect(kit.find((s) => s.role === role)!.entry!.library, role).toBe('drLuke');
    }
    const bright = drumKit('brightPop');
    expect(kit.find((s) => s.role === 'hiHatClosed1')!.entry!.id).toBe(bright.find((s) => s.role === 'hiHatClosed1')!.entry!.id);
  });

  it('its verses take the hip-hop drum styles, its other sections Bright Pop\'s', () => {
    const styles = GENRE_RECIPES.casperakiPop.drumStyles.verse;
    expect(drumStylesFor({ recipe: GENRE_RECIPES.casperakiPop }, 'verse2')).toEqual(styles);
    expect(drumStylesFor({ recipe: GENRE_RECIPES.casperakiPop }, 'chorus1')).toBeUndefined();
    expect(drumStylesFor({}, 'verse1')).toBeUndefined();
    for (let i = 0; i < 20; i++) expect(styles).toContain(selectDrumBlueprint(createRng(`v${i}`), 'brightPop', styles).styleName);
    expect(() => selectDrumBlueprint(createRng('x'), 'brightPop', ['nope'])).toThrow(/nope/u);
  });

  it('its guitar plays syncopated patterns: Funk and R&B strumming only (owner 2026-11-28)', () => {
    for (let i = 0; i < 20; i++) {
      const sel = selectVirtualGuitaristPattern(createRng(`g${i}`), 'brightPop', 110, GENRE_RECIPES.casperakiPop.guitarPatterns);
      expect(sel.patternName, sel.patternName).toMatch(/-(Funk|R&B)-/u);
    }
    expect(() => selectVirtualGuitaristPattern(createRng('x'), 'brightPop', 110, ['Nope'])).toThrow(/Nope/u);
  });

  it('every section has the trap hi-hats (16ths with rolls) over its own kick and snare (owner 2026-11-28)', () => {
    const ctx = { params: { genre: 'brightPop', key: 'C', bpm: 110, seed: 'hats' }, rng: createRng('hats'), recipe: GENRE_RECIPES.casperakiPop };
    const trap = selectDrumBlueprint(ctx.rng.fork('patterns/drums/hiHats'), 'brightPop', [GENRE_RECIPES.casperakiPop.hiHats]);
    const hatsOf = (bars: { notes?: Record<string, { note: number }[]> }[]) =>
      bars.flatMap((b, i) => Object.entries(b.notes ?? {}).flatMap(([beat, evs]) => evs.filter((e) => e.note === 42).map(() => i * 4 + Number(beat)))).sort((a, b) => a - b);
    const want = (trap.blueprint as Record<string, number[]>).hiHatClosed1!.filter((t) => t < 8).sort((a, b) => a - b);
    for (const name of ['verse1', 'chorus1']) {
      const seg = { name, bars: Array.from({ length: 4 }, () => ({ chords: ['C', 'C', 'C', 'C'] })) } as never;
      const pat = generateDrumPattern(ctx as never, seg, ['drums'])!;
      expect(hatsOf(pat.bars as never).filter((t) => t < 8), name).toEqual(want);
      // its own kick is there too
      expect(pat.bars.some((b) => Object.values(b.notes ?? {}).some((evs) => (evs as { note: number }[]).some((e) => e.note === 36))), name).toBe(true);
    }
  });

  it('the legacy section variety never takes the verses\' hip-hop groove or any section\'s trap hats (owner 2026-11-28: "not sure it always gets that hip hop rhythm in the verse")', () => {
    const HATS = new Set([42, 44, 46]);
    const notesOf = (pat: { bars: { notes?: Record<string, { note?: number }[]> }[] }) =>
      pat.bars.flatMap((b) => Object.values(b.notes ?? {}).flat().map((e) => e.note));
    for (let i = 0; i < 12; i++) {
      const s = orchestrate({ genre: 'casperakiPop', key: 'C', bpm: 105, seed: `groove-${i}` });
      const drums = 'Drums';
      for (const seg of s.songStructure) {
        const pat = s.arrangement[seg.name]!.overrides[drums] as never;
        if (!pat) continue;
        const notes = notesOf(pat);
        if (notes.length === 0) continue; // a deliberate drop-out
        expect(notes.some((n) => HATS.has(n!)), `${i} ${seg.name} has hi-hats`).toBe(true);
      }
    }
  });

  it('a bouncy plucked synth plays in every section, and every guitar is a clean electric, never acoustic or distorted (owner 2026-11-28)', () => {
    for (let i = 0; i < 12; i++) {
      const s = orchestrate({ genre: 'casperakiPop', key: 'C', bpm: 105, seed: `roster-${i}` });
      const types = s.instrumentDefinitions.map((d) => [d.name, String(d.instrumentGroup), String(d.lowLevelType)] as const);
      const pluck = types.find(([, , low]) => low === 'synthsPlucked');
      expect(pluck, `${i}: ${JSON.stringify(types)}`).toBeDefined();
      for (const seg of s.songStructure) expect(Object.keys(s.arrangement[seg.name]!.overrides), `${i} ${seg.name}`).toContain(pluck![0]);
      for (const [name, group, low] of types) {
        if (!/guitar/iu.test(group) && !/guitar/iu.test(low)) continue;
        expect(ELECTRIC_CLEAN, `${i} ${name} ${low}`).toContain(low);
      }
    }
  });

  it('a base genre is generated as before (no recipe)', () => {
    expect(orchestrate({ genre: 'brightPop', key: 'C', bpm: 110, seed: 'casperaki-pop' }).genre).toBe('brightPop');
  });
});
