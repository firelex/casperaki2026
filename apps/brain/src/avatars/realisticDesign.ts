// Realistic avatars (docs/superpowers/specs/2026-11-28-realistic-avatars-design.md): a user's design of a MakeHuman
// person, and the curated library of assets it is made of (apps/models/services/avatar-builder/library.json, its
// AVATAR_LIBRARY_FILE). The avatar builder checks the same things (pipeline/design.py); the brain checks first, so a
// bad design is refused at once with a message naming what is wrong.

import { readFileSync } from 'node:fs';

import { z } from 'zod';

const unit = z.number().min(0).max(1);
const face = z.number().min(-1).max(1);
const colour = z.string().regex(/^#[0-9a-fA-F]{6}$/u, 'a colour is #rrggbb');
const id = z.string().min(1).max(120);

export const RealisticDesignSchema = z
  .object({
    body: z.object({ gender: unit, age: z.number().min(18).max(90), weight: unit, muscle: unit, proportions: unit }).strict(),
    ancestry: z.object({ african: unit, asian: unit, european: unit }).strict(),
    face: z
      .object({ jawWidth: face, chin: face, noseWidth: face, noseLength: face, eyeSize: face, lips: face, cheekbones: face, browAngle: face, feminine: face })
      .strict(),
    skin: id,
    eyes: id,
    eyebrows: id,
    hair: id,
    hairColour: id.nullable(),
    hairTint: colour.nullable(),
    lips: colour.nullable(),
    clothes: z.array(id).max(6),
  })
  .strict();
export type RealisticDesign = z.infer<typeof RealisticDesignSchema>;

const Entry = z.object({ id, name: z.string(), path: z.string(), licence: z.enum(['CC0', 'CC-BY']), author: z.string(), credit: z.array(z.string()).optional() }).passthrough();
export const SLOTS = ['top', 'bottoms', 'dress', 'shoes', 'glasses', 'hat'] as const;
const LibrarySchema = z
  .object({
    skins: z.array(Entry),
    eyes: z.array(Entry),
    eyebrows: z.array(Entry),
    hair: z.array(Entry.extend({ colours: z.array(z.object({ id, name: z.string(), material: z.string(), licence: z.string(), author: z.string() }).passthrough()) })),
    clothes: z.array(Entry.extend({ slot: z.enum(SLOTS), covers: z.array(z.enum(SLOTS)) })),
  })
  .strict();
export type RealisticLibrary = z.infer<typeof LibrarySchema>;

/** Reads the curated library; throws naming the file for one that is missing or malformed. */
export function loadRealisticLibrary(file: string): RealisticLibrary {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`realistic avatars: cannot read the library ${file}: ${(err as Error).message}`);
  }
  const parsed = LibrarySchema.safeParse(json);
  if (!parsed.success) throw new Error(`realistic avatars: the library ${file} is malformed: ${parsed.error.issues[0]!.path.join('.')}: ${parsed.error.issues[0]!.message}`);
  return parsed.data;
}

/** The library as the dressing room sees it: names, slots, licences and credits, no file paths. */
export function publicLibrary(lib: RealisticLibrary) {
  const strip = <T extends { path?: string; uuid?: unknown; material?: string }>(e: T) => {
    const { path: _p, uuid: _u, material: _m, ...rest } = e;
    return rest;
  };
  return {
    skins: lib.skins.map(strip),
    eyes: lib.eyes.map(strip),
    eyebrows: lib.eyebrows.map(strip),
    hair: lib.hair.map((h) => ({ ...strip(h), colours: h.colours.map(strip) })),
    clothes: lib.clothes.map(strip),
  };
}

/** Throws, naming the problem, for a design the library cannot build: an unknown asset, a hair colour the hair does
 *  not have, two garments covering one slot, or an ancestry mix that does not add up to 1. */
export function checkDesign(design: RealisticDesign, lib: RealisticLibrary): void {
  const shares = Object.values(design.ancestry);
  if (Math.abs(shares.reduce((a, b) => a + b, 0) - 1) > 0.01) throw new Error(`the ancestry mix must add up to 1 (got ${shares.join(' + ')})`);
  const find = <T extends { id: string }>(list: readonly T[], kind: string, wanted: string): T => {
    const e = list.find((x) => x.id === wanted);
    if (!e) throw new Error(`there is no ${kind} "${wanted}" in the library`);
    return e;
  };
  find(lib.skins, 'skin', design.skin);
  find(lib.eyes, 'eyes', design.eyes);
  find(lib.eyebrows, 'eyebrows', design.eyebrows);
  const hair = find(lib.hair, 'hair', design.hair);
  if (design.hairColour !== null && !hair.colours.some((c) => c.id === design.hairColour)) throw new Error(`the hair "${hair.id}" has no colour "${design.hairColour}"`);
  const taken = new Map<string, string>();
  for (const g of design.clothes.map((c) => find(lib.clothes, 'clothes', c))) {
    for (const slot of [g.slot, ...g.covers]) {
      const other = taken.get(slot);
      if (other) throw new Error(`"${other}" and "${g.id}" both cover the ${slot}: choose one`);
      taken.set(slot, g.id);
    }
  }
}
