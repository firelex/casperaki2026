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

  // Owner 2026-11-28: "In the latest casperaki song I wasn't able to get proper strummed guitars" (the Funk and R&B
  // patterns are a strum a bar and single-string picking).
  it('its guitar strums: recorded strums only, at least 4 a bar, a third or more off the beat, from both banks', () => {
    const sources = new Set<string>();
    for (const bpm of [95, 110, 120, 129]) {
      for (let i = 0; i < 25; i++) {
        const sel = selectVirtualGuitaristPattern(createRng(`g${bpm}-${i}`), 'brightPop', bpm, GENRE_RECIPES.casperakiPop.guitarPatterns);
        sources.add(sel.source);
        const events = sel.pattern.bars.flatMap((bar) => Object.entries(bar.notes).flatMap(([beat, evs]) => evs.map((e) => ({ beat: Number.parseFloat(beat), e: e as { type: string; event?: string } }))));
        expect(events.filter((x) => x.e.type === 'strum'), sel.patternName).toEqual([]);
        const strums = events.filter((x) => x.e.type === 'virtualGuitarist' && x.e.event!.startsWith('chord'));
        expect(strums.length / sel.pattern.bars.length, sel.patternName).toBeGreaterThanOrEqual(4);
        expect(strums.filter((x) => x.beat % 1 !== 0).length / strums.length, sel.patternName).toBeGreaterThanOrEqual(0.3);
      }
    }
    expect([...sources].sort()).toEqual(['main', 'stefan']);
    expect(() => selectVirtualGuitaristPattern(createRng('x'), 'brightPop', 110, { families: ['Nope'] })).toThrow(/Nope/u);
  });

  // Owner 2026-11-28: "casperaki pop should always use strum patterns, no finger-picking" (pattern-lab styles too).
  it('a song\'s guitars play no single strings, in any section', () => {
    for (const seed of ['s1', 's2', 's3', 's4', 's5', 's6']) {
      const song = orchestrate({ genre: 'casperakiPop', key: 'C', bpm: 118, seed });
      for (const [sec, a] of Object.entries(song.arrangement)) {
        for (const [track, o] of Object.entries(a.overrides)) {
          if (!track.startsWith('Guitar')) continue;
          for (const b of o.bars ?? []) for (const evs of Object.values(b.notes ?? {})) for (const e of evs ?? []) expect((e as { type: string }).type, `${seed} ${sec} ${track}`).not.toBe('strum');
        }
      }
    }
  });

  it('the verses take the hip-hop generator\'s hi-hats over their own kick and snare; the other sections keep their own hats (owner 2026-11-28: "we can\'t have it in all segments")', () => {
    const recipe = GENRE_RECIPES.casperakiPop;
    const mk = () => ({ params: { genre: 'brightPop', key: 'C', bpm: 110, seed: 'hats' }, rng: createRng('hats'), recipe });
    const plain = () => ({ params: { genre: 'brightPop', key: 'C', bpm: 110, seed: 'hats' }, rng: createRng('hats') });
    const hip = selectDrumBlueprint(createRng('hats').fork('patterns/drums/hiHats'), 'brightPop', [recipe.hiHats.style]);
    const hatsOf = (bars: { notes?: Record<string, { note: number }[]> }[]) =>
      bars.flatMap((b, i) => Object.entries(b.notes ?? {}).flatMap(([beat, evs]) => evs.filter((e) => e.note === 42).map(() => i * 4 + Number(beat)))).sort((a, b) => a - b);
    const seg = (name: string) => ({ name, bars: Array.from({ length: 4 }, () => ({ chords: ['C', 'C', 'C', 'C'] })) }) as never;
    const want = (hip.blueprint as Record<string, number[]>).hiHatClosed1!.filter((t) => t < 8).sort((a, b) => a - b);
    const verse = generateDrumPattern(mk() as never, seg('verse1'), ['drums'])!;
    expect(hatsOf(verse.bars as never).filter((t) => t < 8)).toEqual(want);
    expect(verse.bars.some((b) => Object.values(b.notes ?? {}).some((evs) => (evs as { note: number }[]).some((e) => e.note === 36)))).toBe(true);
    // a chorus plays its own (Bright Pop) hats, exactly as without the recipe's hats
    const chorus = generateDrumPattern(mk() as never, seg('chorus1'), ['drums'])!;
    const own = generateDrumPattern({ ...plain(), recipe: { ...recipe, hiHats: undefined } } as never, seg('chorus1'), ['drums'])!;
    expect(hatsOf(chorus.bars as never)).toEqual(hatsOf(own.bars as never));
  });

  // Owner 2026-11-28: "it can go up to 120 and that makes the bass drum patterns too busy" -> half time (the hip-hop
  // styles are written for Urban's 60-100 bpm).
  it('above 100 bpm the verses play their hip-hop kick and snare in half time; their hats and the other sections do not change', () => {
    const recipe = GENRE_RECIPES.casperakiPop;
    expect(recipe.drumHalfTime).toEqual({ sectionTypes: ['verse'], aboveBpm: 100 });
    const ctx = (bpm: number) => ({ params: { genre: 'brightPop', key: 'C', bpm, seed: 'ht' }, rng: createRng('ht'), recipe }) as never;
    const seg = (name: string) => ({ name, bars: Array.from({ length: 8 }, () => ({ chords: ['C', 'C', 'C', 'C'] })) }) as never;
    const hits = (bars: { notes?: Record<string, { note: number }[]> }[], notes: number[]) =>
      bars.flatMap((b, i) => Object.entries(b.notes ?? {}).flatMap(([beat, evs]) => evs.filter((e) => notes.includes(e.note)).map((e) => `${e.note}@${i * 4 + Number(beat)}`))).sort();
    const KICK_SNARE = [36, 38];
    for (const seed of ['a', 'b', 'c', 'd']) {
      const c = (bpm: number) => ({ ...(ctx(bpm) as object), rng: createRng(seed) }) as never;
      const full = generateDrumPattern(c(100), seg('verse1'), ['drums'])!;
      const half = generateDrumPattern(c(120), seg('verse1'), ['drums'])!;
      // every kick and snare at 120 is one at 100 (in its first 4 bars) at twice the time
      const fullAt = new Set(hits(full.bars as never, KICK_SNARE).map((h) => { const [n, t] = h.split('@'); return `${n}@${Number(t) * 2}`; }));
      const halfHits = hits(half.bars as never, KICK_SNARE);
      expect(halfHits.length).toBeGreaterThan(0);
      for (const h of halfHits) expect(fullAt.has(h), `${seed}: ${h}`).toBe(true);
      expect(halfHits.length).toBeLessThan(hits(full.bars as never, KICK_SNARE).length);
      // the hats keep their pace
      expect(hits(half.bars as never, [42])).toEqual(hits(full.bars as never, [42]));
      // a chorus is the same at both tempos
      expect(hits(generateDrumPattern(c(120), seg('chorus1'), ['drums'])!.bars as never, [36, 38, 42])).toEqual(hits(generateDrumPattern(c(100), seg('chorus1'), ['drums'])!.bars as never, [36, 38, 42]));
    }
  });

  it('the legacy section variety never takes the verses\' hip-hop groove or their hi-hats (owner 2026-11-28: "not sure it always gets that hip hop rhythm in the verse")', () => {
    const HATS = new Set([42, 44, 46]);
    const notesOf = (pat: { bars: { notes?: Record<string, { note?: number }[]> }[] }) =>
      pat.bars.flatMap((b) => Object.values(b.notes ?? {}).flat().map((e) => e.note));
    for (let i = 0; i < 12; i++) {
      const s = orchestrate({ genre: 'casperakiPop', key: 'C', bpm: 105, seed: `groove-${i}` });
      for (const seg of s.songStructure.filter((x) => x.name.startsWith('verse'))) {
        const pat = s.arrangement[seg.name]!.overrides['Drums'] as never;
        if (!pat) continue;
        const notes = notesOf(pat);
        expect(notes.some((n) => HATS.has(n!)), `${i} ${seg.name} has hi-hats`).toBe(true);
        expect(notes.some((n) => n === 36 || n === 35), `${i} ${seg.name} has its kick`).toBe(true);
      }
    }
  });

  it('a bouncy plucked synth plays in every section but the verses, and every guitar is a clean electric, never acoustic or distorted (owner 2026-11-28)', () => {
    for (let i = 0; i < 12; i++) {
      const s = orchestrate({ genre: 'casperakiPop', key: 'C', bpm: 105, seed: `roster-${i}` });
      const types = s.instrumentDefinitions.map((d) => [d.name, String(d.instrumentGroup), String(d.lowLevelType)] as const);
      const pluck = types.find(([, , low]) => low === 'synthsPlucked');
      expect(pluck, `${i}: ${JSON.stringify(types)}`).toBeDefined();
      // every section but the lean verses (see "lean verse, full chorus")
      for (const seg of s.songStructure.filter((x) => !x.name.startsWith('verse'))) expect(Object.keys(s.arrangement[seg.name]!.overrides), `${i} ${seg.name}`).toContain(pluck![0]);
      for (const [name, group, low] of types) {
        if (!/guitar/iu.test(group) && !/guitar/iu.test(low)) continue;
        expect(ELECTRIC_CLEAN, `${i} ${name} ${low}`).toContain(low);
      }
    }
  });

  it('lean verse, full chorus: a verse plays drums, bass, the guitar and one more part (never the plucked synth); a chorus has more parts than the verse, rotating as the patterns do (owner 2026-11-28: "as long as we have more in the chorus than in the verse")', () => {
    const parts = (s: ReturnType<typeof orchestrate>, sec: string) =>
      Object.keys(s.arrangement[sec]!.overrides).filter((k) => !/^(Vocal|Backing vocals)/u.test(k) && k !== 'Loop').sort();
    let notFull = 0;
    for (let i = 0; i < 10; i++) {
      const s = orchestrate({ genre: 'casperakiPop', key: 'C', bpm: 110, seed: `variety-${i}` });
      const guitar = s.instrumentDefinitions.find((d) => ELECTRIC_CLEAN.includes(String(d.lowLevelType)))!.name;
      const pluck = s.instrumentDefinitions.find((d) => d.lowLevelType === 'synthsPlucked')!.name;
      const song = s.instrumentDefinitions.map((d) => d.name).filter((n) => !/^(Vocal|Backing vocals)/u.test(n) && n !== 'Loop').sort();
      for (const seg of s.songStructure) {
        const p = parts(s, seg.name);
        if (seg.name.startsWith('verse')) {
          expect(p, `${i} ${seg.name}`).toEqual(expect.arrayContaining(['Bass', 'Drums', guitar]));
          expect(p.length, `${i} ${seg.name} ${p}`).toBe(4);
          expect(p, `${i} ${seg.name}`).not.toContain(pluck);
        }
      }
      // the chorus has more parts than the verse, drawn as the patterns rotate (not every part of the song every time)
      const verseCount = parts(s, s.songStructure.find((x) => x.name.startsWith('verse'))!.name).length;
      for (const seg of s.songStructure.filter((x) => x.name.startsWith('chorus'))) {
        expect(parts(s, seg.name).length, `${i} ${seg.name}`).toBeGreaterThan(verseCount);
        if (parts(s, seg.name).length < song.length) notFull++;
      }
    }
    expect(notFull, 'some choruses rotate parts out').toBeGreaterThan(0);
  });

  it('a base genre is generated as before (no recipe)', () => {
    expect(orchestrate({ genre: 'brightPop', key: 'C', bpm: 110, seed: 'casperaki-pop' }).genre).toBe('brightPop');
  });
});
