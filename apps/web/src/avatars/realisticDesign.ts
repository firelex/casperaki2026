// The realistic dressing room's design (docs/superpowers/specs/2026-11-28-realistic-avatars-design.md): the same
// RealisticDesign the brain checks (apps/brain/src/avatars/realisticDesign.ts), the library as the brain lists it
// (no file paths), and the edits the page makes: ancestry shares kept adding up to 1, and clothes chosen by slot.

export type Licence = 'CC0' | 'CC-BY';
export interface LibraryEntry {
  readonly id: string;
  readonly name: string;
  readonly licence: Licence;
  readonly author: string;
  readonly credit?: readonly string[];
}
export const SLOTS = ['top', 'bottoms', 'dress', 'shoes', 'glasses', 'hat'] as const;
export type Slot = (typeof SLOTS)[number];
export const SLOT_LABELS: Readonly<Record<Slot, string>> = { top: 'Top', bottoms: 'Trousers or skirt', dress: 'Dress', shoes: 'Shoes', glasses: 'Glasses', hat: 'Hat' };

export interface RealisticLibraryInfo {
  readonly skins: readonly LibraryEntry[];
  readonly eyes: readonly LibraryEntry[];
  readonly eyebrows: readonly LibraryEntry[];
  readonly hair: readonly (LibraryEntry & { readonly colours: readonly LibraryEntry[] })[];
  readonly clothes: readonly (LibraryEntry & { readonly slot: string; readonly covers: readonly string[] })[];
}

export interface Ancestry {
  readonly african: number;
  readonly asian: number;
  readonly european: number;
}
export const ANCESTRY_LABELS: Readonly<Record<keyof Ancestry, string>> = { african: 'African', asian: 'Asian', european: 'European' };

export const FACE_SLIDERS = ['jawWidth', 'chin', 'noseWidth', 'noseLength', 'eyeSize', 'lips', 'cheekbones', 'browAngle', 'feminine'] as const;
export type FaceSlider = (typeof FACE_SLIDERS)[number];
/** Each face slider's label and what its two ends do. */
export const FACE_LABELS: Readonly<Record<FaceSlider, readonly [string, string, string]>> = {
  jawWidth: ['Jaw', 'narrow', 'wide'],
  chin: ['Chin', 'soft', 'strong'],
  noseWidth: ['Nose width', 'narrow', 'wide'],
  noseLength: ['Nose length', 'short', 'long'],
  eyeSize: ['Eyes', 'small', 'large'],
  lips: ['Lips', 'thin', 'full'],
  cheekbones: ['Cheekbones', 'flat', 'high'],
  browAngle: ['Brows', 'lowered', 'raised'],
  feminine: ['Face', 'more masculine', 'more feminine'],
};

export interface RealisticDesign {
  readonly body: { readonly gender: number; readonly age: number; readonly weight: number; readonly muscle: number; readonly proportions: number };
  readonly ancestry: Ancestry;
  readonly face: Readonly<Record<FaceSlider, number>>;
  readonly skin: string;
  readonly eyes: string;
  readonly eyebrows: string;
  readonly hair: string;
  readonly hairColour: string | null;
  readonly hairTint: string | null;
  readonly lips: string | null;
  readonly clothes: readonly string[];
}

const pick = <T extends { id: string }>(list: readonly T[], preferred: string, what: string): string => {
  const e = list.find((x) => x.id === preferred) ?? list[0];
  if (!e) throw new Error(`The realistic library has no ${what}.`);
  return e.id;
};

/** A new avatar's design: a woman in her twenties in everyday clothes, from what the library has. */
export function defaultDesign(lib: RealisticLibraryInfo): RealisticDesign {
  const clothes = (['punkduck_sleeveless_crop_top', 'elvs_jeans_bootcut', 'shoes02'] as const).filter((id) => lib.clothes.some((c) => c.id === id));
  return {
    body: { gender: 0, age: 26, weight: 0.45, muscle: 0.5, proportions: 0.7 },
    ancestry: { african: 0, asian: 0, european: 1 },
    face: { jawWidth: 0, chin: 0, noseWidth: 0, noseLength: 0, eyeSize: 0, lips: 0, cheekbones: 0, browAngle: 0, feminine: 0 },
    skin: pick(lib.skins, 'young_caucasian_female', 'skins'),
    eyes: pick(lib.eyes, 'brown', 'eyes'),
    eyebrows: pick(lib.eyebrows, 'eyebrow003', 'eyebrows'),
    hair: pick(lib.hair, 'long01', 'hair'),
    hairColour: null,
    hairTint: null,
    lips: null,
    clothes,
  };
}

/** Sets one ancestry share; the other two share the rest in the proportion they had (equally when both were 0). */
export function setAncestry(a: Ancestry, key: keyof Ancestry, value: number): Ancestry {
  const v = Math.min(1, Math.max(0, value));
  const others = (Object.keys(a) as (keyof Ancestry)[]).filter((k) => k !== key);
  const before = others.reduce((s, k) => s + a[k], 0);
  const out = { ...a, [key]: v } as Record<keyof Ancestry, number>;
  for (const k of others) out[k] = before > 0 ? (a[k] / before) * (1 - v) : (1 - v) / others.length;
  return out;
}

const garment = (lib: RealisticLibraryInfo, id: string) => {
  const g = lib.clothes.find((c) => c.id === id);
  if (!g) throw new Error(`The realistic library has no garment "${id}".`);
  return g;
};
const slotsOf = (g: { slot: string; covers: readonly string[] }) => [g.slot, ...g.covers];

/** The garment covering `slot`, if any. */
export function garmentIn(clothes: readonly string[], lib: RealisticLibraryInfo, slot: string): string | undefined {
  return clothes.find((id) => slotsOf(garment(lib, id)).includes(slot));
}

/** Puts `id` on (or, with null, takes off what covers `slot`), taking off every garment it would clash with. */
export function chooseGarment(clothes: readonly string[], lib: RealisticLibraryInfo, slot: string, id: string | null): string[] {
  const freed = id === null ? [slot] : slotsOf(garment(lib, id));
  const kept = clothes.filter((c) => !slotsOf(garment(lib, c)).some((s) => freed.includes(s)));
  return id === null ? kept : [...kept, id];
}

/** The garments of one slot (the slot a garment is filed under). */
export function garmentsFor(lib: RealisticLibraryInfo, slot: Slot) {
  return lib.clothes.filter((c) => c.slot === slot);
}

export type AvatarStyle = 'anime' | 'realistic';
/** The avatars of one style (avatars stored before styles existed are anime). */
export function ofStyle<T extends { style?: AvatarStyle }>(avatars: readonly T[], style: AvatarStyle): T[] {
  return avatars.filter((a) => (a.style ?? 'anime') === style);
}
/** The styles the user has avatars in, anime first. */
export function stylesOf<T extends { style?: AvatarStyle }>(avatars: readonly T[]): AvatarStyle[] {
  return (['anime', 'realistic'] as const).filter((s) => ofStyle(avatars, s).length > 0);
}
