import { describe, expect, it } from 'vitest';

import { chooseGarment, defaultDesign, garmentIn, setAncestry, type RealisticLibraryInfo } from '../src/avatars/realisticDesign';

const g = (id: string, slot: string, covers: string[] = []) => ({ id, name: id, slot, covers, licence: 'CC0' as const, author: 'MakeHuman' });
const lib: RealisticLibraryInfo = {
  skins: [{ id: 'young_caucasian_female', name: 'Skin', licence: 'CC0', author: 'MakeHuman' }],
  eyes: [{ id: 'brown', name: 'Brown', licence: 'CC0', author: 'MakeHuman' }],
  eyebrows: [{ id: 'eyebrow001', name: 'Brows', licence: 'CC0', author: 'MakeHuman' }],
  hair: [{ id: 'long01', name: 'Long', licence: 'CC0', author: 'MakeHuman', colours: [] }],
  clothes: [g('tee', 'top'), g('jeans', 'bottoms'), g('suit', 'top', ['bottoms']), g('dress', 'dress', ['top', 'bottoms']), g('shoes', 'shoes')],
};

describe('a new design', () => {
  it('is complete and uses only the library', () => {
    const d = defaultDesign(lib);
    expect(d.skin).toBe('young_caucasian_female');
    expect(d.hair).toBe('long01');
    expect(Object.values(d.ancestry).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(d.clothes.every((c) => lib.clothes.some((x) => x.id === c))).toBe(true);
    expect(d.body.age).toBeGreaterThanOrEqual(18);
  });
});

describe('ancestry', () => {
  it('keeps the three shares adding up to 1, the others sharing the rest as they were', () => {
    const d = setAncestry({ african: 0.2, asian: 0.2, european: 0.6 }, 'african', 0.6);
    expect(d.african).toBeCloseTo(0.6, 10);
    expect(d.asian).toBeCloseTo(0.1, 10);
    expect(d.european).toBeCloseTo(0.3, 10);
    const all = setAncestry({ african: 0, asian: 0, european: 1 }, 'european', 0.4);
    expect(all.african + all.asian + all.european).toBeCloseTo(1, 10);
    expect(all.african).toBeCloseTo(0.3, 10);
  });
});

describe('clothes', () => {
  it('replaces whatever covered the same slots', () => {
    expect(chooseGarment(['tee', 'jeans', 'shoes'], lib, 'top', 'suit')).toEqual(['shoes', 'suit']);
    expect(chooseGarment(['suit', 'shoes'], lib, 'bottoms', 'jeans')).toEqual(['shoes', 'jeans']);
    expect(chooseGarment(['tee', 'jeans'], lib, 'dress', 'dress')).toEqual(['dress']);
    expect(chooseGarment(['tee', 'jeans'], lib, 'top', null)).toEqual(['jeans']);
  });
  it('tells which garment covers a slot', () => {
    expect(garmentIn(['suit', 'shoes'], lib, 'bottoms')).toBe('suit');
    expect(garmentIn(['shoes'], lib, 'top')).toBeUndefined();
  });
});

describe('the video style switch', () => {
  it('shows the avatars of the chosen style; avatars stored before styles are anime', async () => {
    const { ofStyle, stylesOf } = await import('../src/avatars/realisticDesign');
    const list = [{ id: 'a', style: 'anime' as const }, { id: 'r', style: 'realistic' as const }, { id: 'old' }];
    expect(ofStyle(list, 'anime').map((a) => a.id)).toEqual(['a', 'old']);
    expect(ofStyle(list, 'realistic').map((a) => a.id)).toEqual(['r']);
    expect(stylesOf(list)).toEqual(['anime', 'realistic']);
    expect(stylesOf([{ id: 'a', style: 'anime' as const }])).toEqual(['anime']);
  });
});

describe('an avatar card\'s credits', () => {
  it('names each CC-BY asset and author once, or nothing', async () => {
    const { creditLine } = await import('../src/pages/AvatarsPage');
    expect(creditLine(undefined)).toBeUndefined();
    expect(creditLine([])).toBeUndefined();
    expect(creditLine([{ name: 'Bootcut jeans', author: 'elvs', licence: 'CC-BY' }, { name: 'Black cocktail dress', author: 'punkduck', licence: 'CC-BY' }])).toBe(
      'Credits (CC-BY): Bootcut jeans by elvs; Black cocktail dress by punkduck',
    );
  });
});
