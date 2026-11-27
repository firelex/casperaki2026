// The dressing room's recipe editing (choosing parts, colourings and tints, the packs' restrictions), the avatars
// API client's pack file URLs, and what the avatar cards say about a voice.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkRecipe, defaultRecipe, parsePack, type PackManifest } from '@casperaki/video/avatar';

import { packFileUrl } from '../src/api/avatars';
import { chooseColor, choosePart, chooseTexture, colorChoices, droppedText, groupLabel, orderedGroups, partThumbnail, textureChoices } from '../src/avatars/recipeEdit';
import { voiceText } from '../src/pages/AvatarsPage';
import type { SingerInfo } from '../src/api/singers';

const item = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id.toUpperCase(), directory: `${id}.vrm`, ...extra });

// A small pack in the Character Studio format, with the restrictions the real packs have.
const pack: PackManifest = parsePack(
  {
    requiredTraits: ['body', 'eyes'],
    traitRestrictions: { outer: { restrictedTraits: [], restrictedTypes: ['hoodie', 'solo'] } },
    typeRestrictions: { pants: ['boots', 'accessory_bottom'] },
    traits: [
      { trait: 'accessories', collection: [item('legstrap', { type: ['accessory_bottom'] }), item('belt')] },
      { trait: 'body', collection: [item('body', { textureCollection: 'skin', thumbnailOverrides: ['s0.png', 's1.png'] })] },
      { trait: 'eyes', collection: [item('eyes', { textureCollection: 'eyecol' })] },
      { trait: 'head', collection: [item('buns', { colorCollection: 'Basic', thumbnail: 'head/buns.png' }), item('bob', { colorCollection: 'Basic' }), item('cap')] },
      { trait: 'chest', collection: [item('hoodie', { type: ['hoodie'], textureCollection: 'tops', thumbnailOverrides: ['h0.png', 'h1.png'] }), item('tee', { textureCollection: 'tops', thumbnail: 'missing.png', thumbnailOverrides: ['t0.png', 't1.png'] })] },
      { trait: 'outer', collection: [item('jacket')] },
      { trait: 'legs', collection: [item('cargo', { type: ['pants'] }), item('skirt', { type: 'skirt' })] },
      { trait: 'feet', collection: [item('tallboots', { type: ['boots'] }), item('sneakers', { type: ['shoes'] })] },
    ],
    textureCollections: [
      { trait: 'skin', collection: [{ id: 'light', name: 'Light', directory: ['a.png', 'b.png'] }, { id: 'dark', name: 'Dark', directory: 'c.png' }] },
      { trait: 'eyecol', collection: [{ id: 'green', name: 'Green', directory: 'g.png', thumbnail: 'g-icon.png' }] },
      { trait: 'tops', collection: [{ id: 'top_0', name: 'top_0', directory: 'top0.png' }, { id: 'top_1', name: 'top_1', directory: 'top1.png' }] },
    ],
    colorCollections: [{ trait: 'Basic', collection: [{ id: 'red', name: 'Red', value: ['#FF0000'] }, { id: 'blue', name: 'Blue', value: '#0000ff' }] }],
  },
  'test',
);

const start = () => {
  const r = defaultRecipe('test', pack);
  return { ...r, parts: { ...r.parts, head: 'buns', chest: 'tee', legs: 'cargo', feet: 'sneakers' } };
};

describe('choosing parts', () => {
  it('puts a part on, keeping a tint the new part also offers and dropping one it does not', () => {
    const tinted = chooseColor(start(), pack, 'head', '#FF0000');
    expect(tinted.colors.head).toBe('#ff0000');
    const bob = choosePart(tinted, pack, 'head', 'bob');
    expect(bob.recipe.parts.head).toBe('bob');
    expect(bob.recipe.colors.head).toBe('#ff0000');
    expect(bob.dropped).toEqual([]);
    const cap = choosePart(tinted, pack, 'head', 'cap');
    expect(cap.recipe.colors.head).toBeUndefined();
    checkRecipe(cap.recipe, pack);
  });

  it('keeps a colouring the new part also has', () => {
    const r = chooseTexture(start(), pack, 'chest', 'top_1');
    expect(choosePart(r, pack, 'chest', 'hoodie').recipe.textures.chest).toBe('top_1');
  });

  it('takes a part off with "none", but never a required one', () => {
    const r = choosePart(chooseColor(start(), pack, 'head', '#0000ff'), pack, 'head', null).recipe;
    expect(r.parts.head).toBeUndefined();
    expect(r.colors.head).toBeUndefined();
    expect(() => choosePart(start(), pack, 'eyes', null)).toThrow(/Eyes can't be left out/u);
  });

  it('a jacket takes off a hoodie, and a hoodie takes off a jacket', () => {
    const hoodie = choosePart(start(), pack, 'chest', 'hoodie').recipe;
    const jacket = choosePart(hoodie, pack, 'outer', 'jacket');
    expect(jacket.recipe.parts.outer).toBe('jacket');
    expect(jacket.recipe.parts.chest).toBeUndefined();
    expect(jacket.dropped).toEqual([{ group: 'chest', name: 'HOODIE', because: 'JACKET' }]);
    expect(droppedText(jacket.dropped)).toBe("HOODIE (top) was taken off: it can't be worn with JACKET.");
    const back = choosePart(jacket.recipe, pack, 'chest', 'hoodie');
    expect(back.recipe.parts.outer).toBeUndefined();
    expect(back.dropped.map((d) => d.group)).toEqual(['outer']);
    // A tee goes under a jacket.
    expect(choosePart(jacket.recipe, pack, 'chest', 'tee').dropped).toEqual([]);
  });

  it('trousers and tall boots don\'t go together, either way round', () => {
    const boots = choosePart(start(), pack, 'feet', 'tallboots');
    expect(boots.recipe.parts.legs).toBeUndefined();
    expect(boots.dropped.map((d) => d.name)).toEqual(['CARGO']);
    const skirt = choosePart(boots.recipe, pack, 'legs', 'skirt');
    expect(skirt.dropped).toEqual([]);
    const pants = choosePart({ ...skirt.recipe, parts: { ...skirt.recipe.parts, accessories: 'legstrap' } }, pack, 'legs', 'cargo');
    expect(pants.dropped.map((d) => d.group).sort()).toEqual(['accessories', 'feet']);
    expect(droppedText([])).toBeUndefined();
  });

  it('refuses parts, colourings and tints the pack does not have', () => {
    expect(() => choosePart(start(), pack, 'head', 'mohawk')).toThrow(/no part "mohawk"/u);
    expect(() => choosePart(start(), pack, 'hat', 'x')).toThrow(/no group "hat"/u);
    expect(() => chooseTexture(start(), pack, 'chest', 'top_9')).toThrow(/no colouring/u);
    expect(() => chooseColor(start(), pack, 'head', '#123456')).toThrow(/can't take the colour/u);
    expect(() => chooseColor(start(), pack, 'outer', '#ff0000')).toThrow(/choose a part before its colour/u);
    expect(chooseTexture(chooseTexture(start(), pack, 'body', 'dark'), pack, 'body', null).textures.body).toBeUndefined();
  });
});

describe('what the choices look like', () => {
  it('shows a part in its first colouring, otherwise by its own thumbnail', () => {
    const chest = pack.traits.find((t) => t.trait === 'chest')!.collection;
    expect(partThumbnail(chest[1]!)).toBe('t0.png');
    expect(partThumbnail(pack.traits.find((t) => t.trait === 'head')!.collection[0]!)).toBe('head/buns.png');
    expect(partThumbnail(pack.traits.find((t) => t.trait === 'head')!.collection[2]!)).toBeUndefined();
  });

  it('lists colourings with their pictures and tints as lowercase hex', () => {
    const body = pack.traits.find((t) => t.trait === 'body')!.collection[0]!;
    expect(textureChoices(pack, body)).toEqual([
      { id: 'light', name: 'Light', thumbnail: 's0.png' },
      { id: 'dark', name: 'Dark', thumbnail: 's1.png' },
    ]);
    const eyes = pack.traits.find((t) => t.trait === 'eyes')!.collection[0]!;
    expect(textureChoices(pack, eyes)).toEqual([{ id: 'green', name: 'Green', thumbnail: 'g-icon.png' }]);
    const buns = pack.traits.find((t) => t.trait === 'head')!.collection[0]!;
    expect(colorChoices(pack, buns).map((c) => c.hex)).toEqual(['#ff0000', '#0000ff']);
  });

  it('names and orders the groups for people', () => {
    expect(orderedGroups(pack)).toEqual(['body', 'eyes', 'head', 'chest', 'outer', 'legs', 'feet', 'accessories']);
    expect(['head', 'chest', 'outer', 'legs', 'feet', 'accessories', 'body', 'eyes'].map(groupLabel)).toEqual(['Hair', 'Top', 'Jacket', 'Trousers & skirts', 'Shoes', 'Accessories', 'Skin', 'Eyes']);
  });
});

describe('the real packs', () => {
  const dir = `${process.env.HOME}/casperaki-data/avatar-packs/character-assets`;
  for (const name of ['drophunter', 'neurohacker']) {
    it.skipIf(!(() => { try { readFileSync(`${dir}/${name}/manifest.json`); return true; } catch { return false; } })())(`${name}: every part's colourings line up with their pictures`, () => {
      const m = parsePack(JSON.parse(readFileSync(`${dir}/${name}/manifest.json`, 'utf8')), name);
      for (const g of m.traits) for (const i of g.collection) {
        textureChoices(m, i);
        colorChoices(m, i);
      }
      const jacket = m.traits.find((t) => t.trait === 'outer')!.collection[0]!.id;
      const solo = m.traits.find((t) => t.trait === 'chest')!.collection.find((i) => JSON.stringify(i.type ?? '').includes('solo'))!;
      const r = choosePart(choosePart(defaultRecipe(name, m), m, 'chest', solo.id).recipe, m, 'outer', jacket);
      expect(r.dropped.map((d) => d.group)).toEqual(['chest']);
    });
  }
});

describe('pack files and voices', () => {
  it('addresses pack files under the brain, one escaped segment at a time', () => {
    expect(packFileUrl('drophunter', './chest/croptop/Croptop-icon0.png')).toBe('/api/avatar-packs/drophunter/chest/croptop/Croptop-icon0.png');
    expect(packFileUrl('drophunter', 'outer/halfjacket/Half Jacket-icon0.png')).toBe('/api/avatar-packs/drophunter/outer/halfjacket/Half%20Jacket-icon0.png');
  });

  it('says which voice an avatar has', () => {
    const singers = [{ id: 'nova', name: 'Nova' }] as SingerInfo[];
    expect(voiceText(null, singers)).toBe('No voice');
    expect(voiceText('nova', singers)).toBe('Voice: Nova');
    expect(voiceText('gone', singers)).toMatch(/no longer have/u);
  });
});
