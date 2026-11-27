// The avatars users dress (Avatars page), kept outside git next to their singers (BRAIN_SINGERS_DATA_DIR):
//
//   <dir>/<owner>/avatars.json               the owner's avatars (UserAvatar[]), oldest first
//   <dir>/<owner>/avatars/<avatar id>.png    its portrait (taken from the dressing room's 3D view)
//
// An avatar is a recipe (pack, parts, colours: @casperaki/video/avatar), not a 3D file, and may carry one of the
// owner's singers (its voice). Seen only by its owner.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { AvatarRecipeSchema, type AvatarRecipe } from '@casperaki/video/avatar';
import { z } from 'zod';

import { ownerFolder } from '../singers/userSingers.js';

export const UserAvatarSchema = z
  .object({
    id: z.string().regex(/^a-[0-9a-f]{12}$/u),
    name: z.string().min(1).max(60),
    // The video engine's schema (its own zod version): checked through it.
    recipe: z.custom<AvatarRecipe>((v) => AvatarRecipeSchema.safeParse(v).success, 'not an avatar recipe'),
    /** One of the owner's singers (built-in or their own), or none. */
    singerId: z.string().min(1).nullable(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();
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

  list(ownerId: string): UserAvatar[] {
    const file = this.listFile(ownerId);
    if (!existsSync(file)) return [];
    return z.array(UserAvatarSchema).parse(JSON.parse(readFileSync(file, 'utf8')));
  }

  get(ownerId: string, id: string): UserAvatar | undefined {
    return this.list(ownerId).find((a) => a.id === id);
  }

  /** Saves a new avatar (or replaces one, keeping its id and creation time) with its portrait. */
  save(ownerId: string, fields: Pick<UserAvatar, 'name' | 'recipe' | 'singerId'>, portrait: Buffer, now: string, id?: string): UserAvatar {
    if (portrait.length > MAX_PORTRAIT_BYTES || !portrait.subarray(0, 8).equals(PNG)) throw new Error('avatars: the portrait is not a PNG of at most 2 MB');
    const avatars = this.list(ownerId);
    const old = id ? avatars.find((a) => a.id === id) : undefined;
    if (id && !old) throw new Error(`avatars: there is no avatar ${id}`);
    const avatar = UserAvatarSchema.parse({ id: old?.id ?? `a-${randomBytes(6).toString('hex')}`, ...fields, createdAt: old?.createdAt ?? now, updatedAt: now });
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
    return true;
  }

  private write(ownerId: string, avatars: UserAvatar[]): void {
    const file = this.listFile(ownerId);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(`${file}.part-${process.pid}`, `${JSON.stringify(avatars, null, 1)}\n`);
    renameSync(`${file}.part-${process.pid}`, file);
  }
}
