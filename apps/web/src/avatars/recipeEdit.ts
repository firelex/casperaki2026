// Editing an avatar recipe in the dressing room: choosing a part (or none) in a group, its colouring (a texture
// from the part's texture collection) and its tint (a colour from its colour collection), keeping the manifest's
// restrictions (a jacket can't go over a hoodie, trousers not with tall boots), and what the choices look like
// (thumbnails, swatches, names for people).

import { colorCollection, packGroup, packItem, textureCollection, type AvatarRecipe, type PackItem, type PackManifest } from '@casperaki/video/avatar';

/** The groups as the dressing room names them. */
export const GROUP_LABELS: Readonly<Record<string, string>> = {
  body: 'Skin',
  eyes: 'Eyes',
  head: 'Hair',
  chest: 'Top',
  outer: 'Jacket',
  legs: 'Trousers & skirts',
  feet: 'Shoes',
  accessories: 'Accessories',
};

/** The order the groups are shown in; a group the pack has that is not named here comes after them. */
const GROUP_ORDER = ['body', 'eyes', 'head', 'chest', 'outer', 'legs', 'feet', 'accessories'];

export function groupLabel(group: string): string {
  const label = GROUP_LABELS[group];
  if (label) return label;
  return group.charAt(0).toUpperCase() + group.slice(1);
}

/** The pack's groups in the dressing room's order. */
export function orderedGroups(pack: PackManifest): string[] {
  const groups = pack.traits.map((t) => t.trait);
  const rank = (g: string) => {
    const i = GROUP_ORDER.indexOf(g);
    return i < 0 ? GROUP_ORDER.length : i;
  };
  return [...groups].sort((a, b) => rank(a) - rank(b));
}

export function isRequired(pack: PackManifest, group: string): boolean {
  return pack.requiredTraits.includes(group);
}

/** The item's types (the manifest writes one as a string or several as a list). */
export function itemTypes(item: PackItem): string[] {
  if (item.type === undefined) return [];
  return typeof item.type === 'string' ? [item.type] : item.type;
}

/** The thumbnails of a part in each of its colourings (the manifest's `thumbnailOverrides`, one per texture). */
function thumbnailOverrides(item: PackItem): string[] | undefined {
  const o = (item as { thumbnailOverrides?: unknown }).thumbnailOverrides;
  if (o === undefined) return undefined;
  if (!Array.isArray(o) || !o.every((x) => typeof x === 'string')) throw new Error(`avatar pack: the part "${item.id}" has thumbnailOverrides that are not a list of file paths`);
  return o as string[];
}

/**
 * The picture of a part, as a pack path. A part with colourings is shown in its first colouring (the packs'
 * own `thumbnail` of such parts names files the packs don't ship); one without, by its `thumbnail`. Undefined: the
 * pack has no picture for it (it is shown by name).
 */
export function partThumbnail(item: PackItem): string | undefined {
  const overrides = thumbnailOverrides(item);
  if (overrides && overrides.length > 0) return overrides[0];
  return item.thumbnail;
}

export interface TextureChoice {
  readonly id: string;
  readonly name: string;
  /** A pack path, or undefined when the pack has no picture of this colouring. */
  readonly thumbnail: string | undefined;
}

/** The colourings a part can wear, each with its picture (the part in that colouring when the pack has one). */
export function textureChoices(pack: PackManifest, item: PackItem): TextureChoice[] {
  if (!item.textureCollection) return [];
  const tc = textureCollection(pack, item.textureCollection);
  if (!tc) throw new Error(`avatar pack: the part "${item.id}" names the texture collection "${item.textureCollection}", which the pack does not have`);
  const overrides = thumbnailOverrides(item);
  if (overrides && overrides.length !== tc.collection.length) {
    throw new Error(`avatar pack: the part "${item.id}" has ${overrides.length} colouring pictures for the ${tc.collection.length} textures of "${tc.trait}"`);
  }
  return tc.collection.map((t, i) => {
    const own = (t as { thumbnail?: unknown }).thumbnail;
    return { id: t.id, name: t.name, thumbnail: overrides ? overrides[i] : typeof own === 'string' ? own : undefined };
  });
}

export interface ColorChoice {
  readonly id: string;
  readonly name: string;
  readonly hex: string;
}

/** The tints a part can take (none when it has no colour collection). */
export function colorChoices(pack: PackManifest, item: PackItem): ColorChoice[] {
  if (!item.colorCollection) return [];
  const cc = colorCollection(pack, item.colorCollection);
  if (!cc) throw new Error(`avatar pack: the part "${item.id}" names the colour collection "${item.colorCollection}", which the pack does not have`);
  return cc.collection.map((c) => ({ id: c.id, name: c.name, hex: c.value[0]!.toLowerCase() }));
}

/** A part taken off because it can't be worn with the new choice. */
export interface DroppedPart {
  readonly group: string;
  readonly name: string;
  /** The new choice it clashed with. */
  readonly because: string;
}

export interface RecipeChange {
  readonly recipe: AvatarRecipe;
  readonly dropped: DroppedPart[];
}

interface TraitRestriction {
  readonly restrictedTraits: string[];
  readonly restrictedTypes: string[];
}

function traitRestrictions(pack: PackManifest): Record<string, TraitRestriction> {
  const raw = (pack as { traitRestrictions?: unknown }).traitRestrictions;
  if (raw === undefined) return {};
  if (!raw || typeof raw !== 'object') throw new Error('avatar pack: traitRestrictions is not an object');
  const out: Record<string, TraitRestriction> = {};
  for (const [g, r] of Object.entries(raw as Record<string, unknown>)) {
    const o = r as { restrictedTraits?: unknown; restrictedTypes?: unknown };
    const list = (v: unknown, what: string): string[] => {
      if (v === undefined) return [];
      if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new Error(`avatar pack: traitRestrictions.${g}.${what} is not a list of names`);
      return v as string[];
    };
    out[g] = { restrictedTraits: list(o.restrictedTraits, 'restrictedTraits'), restrictedTypes: list(o.restrictedTypes, 'restrictedTypes') };
  }
  return out;
}

function typeRestrictions(pack: PackManifest): Record<string, string[]> {
  const raw = (pack as { typeRestrictions?: unknown }).typeRestrictions;
  if (raw === undefined) return {};
  if (!raw || typeof raw !== 'object') throw new Error('avatar pack: typeRestrictions is not an object');
  for (const [t, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new Error(`avatar pack: typeRestrictions.${t} is not a list of types`);
  }
  return raw as Record<string, string[]>;
}

/** Whether a part `a` in group `ga` and a part `b` in group `gb` can't be worn together (in either direction). */
function clash(pack: PackManifest, ga: string, a: PackItem, gb: string, b: PackItem): boolean {
  const tr = traitRestrictions(pack);
  const ty = typeRestrictions(pack);
  const ta = itemTypes(a);
  const tb = itemTypes(b);
  const oneWay = (g1: string, t1: string[], g2: string, t2: string[]) => {
    const r = tr[g1];
    if (r && (r.restrictedTraits.includes(g2) || t2.some((t) => r.restrictedTypes.includes(t)))) return true;
    return t1.some((t) => (ty[t] ?? []).some((u) => t2.includes(u)));
  };
  return oneWay(ga, ta, gb, tb) || oneWay(gb, tb, ga, ta);
}

/**
 * Puts the part `itemId` on in `group` (null: takes the group's part off; not allowed for a required group). The
 * part's colouring and tint are kept when the new part offers the same ones, and dropped when not. Parts the new
 * one can't be worn with (the manifest's restrictions) are taken off and listed.
 */
export function choosePart(recipe: AvatarRecipe, pack: PackManifest, group: string, itemId: string | null): RecipeChange {
  if (!packGroup(pack, group)) throw new Error(`avatar pack "${recipe.pack}" has no group "${group}"`);
  const parts = { ...recipe.parts };
  const textures = { ...recipe.textures };
  const colors = { ...recipe.colors };
  if (itemId === null) {
    if (isRequired(pack, group)) throw new Error(`${groupLabel(group)} can't be left out`);
    delete parts[group];
    delete textures[group];
    delete colors[group];
    return { recipe: { ...recipe, parts, textures, colors }, dropped: [] };
  }
  const item = packItem(pack, group, itemId);
  if (!item) throw new Error(`avatar pack "${recipe.pack}": "${group}" has no part "${itemId}"`);
  parts[group] = itemId;
  const tex = textures[group];
  if (tex !== undefined && !textureChoices(pack, item).some((t) => t.id === tex)) delete textures[group];
  const hex = colors[group];
  if (hex !== undefined && !colorChoices(pack, item).some((c) => c.hex === hex.toLowerCase())) delete colors[group];

  const dropped: DroppedPart[] = [];
  for (const [g, id] of Object.entries(recipe.parts)) {
    if (g === group) continue;
    const other = packItem(pack, g, id);
    if (!other) throw new Error(`avatar pack "${recipe.pack}": "${g}" has no part "${id}"`);
    if (!clash(pack, group, item, g, other)) continue;
    if (isRequired(pack, g)) throw new Error(`${item.name} can't be worn with the ${groupLabel(g).toLowerCase()} "${other.name}", which can't be left out`);
    delete parts[g];
    delete textures[g];
    delete colors[g];
    dropped.push({ group: g, name: other.name, because: item.name });
  }
  return { recipe: { ...recipe, parts, textures, colors }, dropped };
}

/** Sets the colouring of the group's part (null: the part's own). */
export function chooseTexture(recipe: AvatarRecipe, pack: PackManifest, group: string, textureId: string | null): AvatarRecipe {
  const textures = { ...recipe.textures };
  if (textureId === null) {
    delete textures[group];
    return { ...recipe, textures };
  }
  const id = recipe.parts[group];
  if (!id) throw new Error(`${groupLabel(group)}: choose a part before its colouring`);
  const item = packItem(pack, group, id);
  if (!item) throw new Error(`avatar pack "${recipe.pack}": "${group}" has no part "${id}"`);
  if (!textureChoices(pack, item).some((t) => t.id === textureId)) throw new Error(`${item.name} has no colouring "${textureId}"`);
  textures[group] = textureId;
  return { ...recipe, textures };
}

/** Sets the tint of the group's part (null: untinted). */
export function chooseColor(recipe: AvatarRecipe, pack: PackManifest, group: string, hex: string | null): AvatarRecipe {
  const colors = { ...recipe.colors };
  if (hex === null) {
    delete colors[group];
    return { ...recipe, colors };
  }
  const id = recipe.parts[group];
  if (!id) throw new Error(`${groupLabel(group)}: choose a part before its colour`);
  const item = packItem(pack, group, id);
  if (!item) throw new Error(`avatar pack "${recipe.pack}": "${group}" has no part "${id}"`);
  if (!colorChoices(pack, item).some((c) => c.hex === hex.toLowerCase())) throw new Error(`${item.name} can't take the colour ${hex}`);
  colors[group] = hex.toLowerCase();
  return { ...recipe, colors };
}

/** A short sentence saying which parts were taken off, or undefined when none were. */
export function droppedText(dropped: readonly DroppedPart[]): string | undefined {
  if (dropped.length === 0) return undefined;
  return dropped.map((d) => `${d.name} (${groupLabel(d.group).toLowerCase()}) was taken off: it can't be worn with ${d.because}.`).join(' ');
}

/** The camera framing for a group (distance from the avatar and height of the eye, metres): the manifest's. */
export function groupCamera(pack: PackManifest, group: string): { distance: number; height: number } | undefined {
  return packGroup(pack, group)?.cameraTarget;
}
