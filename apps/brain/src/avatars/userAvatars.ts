// The avatars users dress (Avatars page), kept outside git next to their singers (BRAIN_SINGERS_DATA_DIR):
//
//   <dir>/<owner>/avatars.json               the owner's avatars (UserAvatar[]), oldest first
//   <dir>/<owner>/avatars/<avatar id>.png    its portrait (taken from the dressing room's 3D view)
//   <dir>/<owner>/avatars/<avatar id>.vrm    a realistic avatar's built person
//
// An anime avatar is a recipe (pack, parts, colours: @casperaki/video/avatar); a realistic one a MakeHuman design and
// the VRM file built from it. Either may carry one of the owner's singers (its voice). Seen only by its owner.

import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { AvatarRecipeSchema, type AvatarRecipe } from '@casperaki/video/avatar';
import { z } from 'zod';

import { ownerFolder } from '../singers/userSingers.js';
import { RealisticDesignSchema, type RealisticDesign } from './realisticDesign.js';

const Common = {
  id: z.string().regex(/^a-[0-9a-f]{12}$/u),
  name: z.string().min(1).max(60),
  /** One of the owner's singers (built-in or their own), or none. */
  singerId: z.string().min(1).nullable(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
};

/** Anime: a recipe of Character Studio pack parts. Avatars stored before styles existed have no `style`: anime. */
const AnimeAvatarSchema = z
  .object({
    style: z.literal('anime'),
    // The video engine's schema (its own zod version): checked through it.
    recipe: z.custom<AvatarRecipe>((v) => AvatarRecipeSchema.safeParse(v).success, 'not an avatar recipe'),
    ...Common,
  })
  .strict();

/** Realistic: a MakeHuman design, built by the avatar builder into <owner>/avatars/<id>.vrm. */
const RealisticAvatarSchema = z
  .object({
    style: z.literal('realistic'),
    design: RealisticDesignSchema,
    /** The assets it is made of that must be credited (CC-BY), from its build. */
    credits: z.array(z.object({ name: z.string(), author: z.string(), licence: z.string() }).strict()),
    ...Common,
  })
  .strict();

export const UserAvatarSchema = z.preprocess(
  (v) => (v && typeof v === 'object' && !('style' in v) ? { ...v, style: 'anime' } : v),
  z.discriminatedUnion('style', [AnimeAvatarSchema, RealisticAvatarSchema]),
);
export type UserAvatar = z.infer<typeof UserAvatarSchema>;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Largest portrait accepted (bytes). */
export const MAX_PORTRAIT_BYTES = 2 * 1024 * 1024;

export class UserAvatars {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private listFile(ownerId: string): string {
    return join(this.root, ownerFolder(ownerId), 'avatars.json');
  }

  portraitPath(ownerId: string, id: string): string {
    if (!/^a-[0-9a-f]{12}$/u.test(id)) throw new Error(`avatars: "${id}" is not an avatar id`);
    return join(this.root, ownerFolder(ownerId), 'avatars', `${id}.png`);
  }

  vrmPath(ownerId: string, id: string): string {
    return this.portraitPath(ownerId, id).replace(/\.png$/u, '.vrm');
  }

  list(ownerId: string): UserAvatar[] {
    const file = this.listFile(ownerId);
    if (!existsSync(file)) return [];
    return z.array(UserAvatarSchema).parse(JSON.parse(readFileSync(file, 'utf8')));
  }

  get(ownerId: string, id: string): UserAvatar | undefined {
    return this.list(ownerId).find((a) => a.id === id);
  }

  /** Saves a new avatar (or replaces one, keeping its id and creation time) with its portrait. */
  save(ownerId: string, fields: { style: 'anime'; name: string; recipe: AvatarRecipe; singerId: string | null }, portrait: Buffer, now: string, id?: string): UserAvatar {
    return this.store(ownerId, fields, portrait, now, id, () => undefined);
  }

  /** Saves a realistic avatar: its design, and the person built from it (copied from `vrmFrom`) as <id>.vrm. */
  saveRealistic(ownerId: string, fields: { name: string; design: RealisticDesign; credits: { name: string; author: string; licence: string }[]; singerId: string | null }, vrmFrom: string, portrait: Buffer, now: string, id?: string): UserAvatar {
    return this.store(ownerId, { style: 'realistic', ...fields }, portrait, now, id, (avatarId) => {
      const vrm = this.vrmPath(ownerId, avatarId);
      mkdirSync(join(vrm, '..'), { recursive: true });
      copyFileSync(vrmFrom, `${vrm}.part-${process.pid}`);
      renameSync(`${vrm}.part-${process.pid}`, vrm);
    });
  }

  private store(ownerId: string, fields: Record<string, unknown>, portrait: Buffer, now: string, id: string | undefined, files: (id: string) => void): UserAvatar {
    if (portrait.length > MAX_PORTRAIT_BYTES || !portrait.subarray(0, 8).equals(PNG)) throw new Error('avatars: the portrait is not a PNG of at most 2 MB');
    const avatars = this.list(ownerId);
    const old = id ? avatars.find((a) => a.id === id) : undefined;
    if (id && !old) throw new Error(`avatars: there is no avatar ${id}`);
    if (old && old.style !== fields['style']) throw new Error(`avatars: ${id} is ${old.style}; it cannot become ${String(fields['style'])}`);
    const avatar = UserAvatarSchema.parse({ id: old?.id ?? `a-${randomBytes(6).toString('hex')}`, ...fields, createdAt: old?.createdAt ?? now, updatedAt: now });
    files(avatar.id);
    const png = this.portraitPath(ownerId, avatar.id);
    mkdirSync(join(png, '..'), { recursive: true });
    writeFileSync(`${png}.part-${process.pid}`, portrait);
    renameSync(`${png}.part-${process.pid}`, png);
    this.write(ownerId, old ? avatars.map((a) => (a.id === avatar.id ? avatar : a)) : [...avatars, avatar]);
    return avatar;
  }

  /** Deletes an avatar and its portrait: false when the owner has no such avatar. */
  remove(ownerId: string, id: string): boolean {
    const avatars = this.list(ownerId);
    if (!avatars.some((a) => a.id === id)) return false;
    this.write(ownerId, avatars.filter((a) => a.id !== id));
    rmSync(this.portraitPath(ownerId, id), { force: true });
    rmSync(this.vrmPath(ownerId, id), { force: true });
    return true;
  }

  private write(ownerId: string, avatars: UserAvatar[]): void {
    const file = this.listFile(ownerId);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(`${file}.part-${process.pid}`, `${JSON.stringify(avatars, null, 1)}\n`);
    renameSync(`${file}.part-${process.pid}`, file);
  }
}
