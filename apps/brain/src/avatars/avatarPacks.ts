// The Character Studio part packs avatars are built from (BRAIN_AVATAR_PACKS_DIR, outside git: the packs' licence is
// unknown, docs/superpowers/specs/2026-11-27-avatars-design.md): one folder per pack holding its manifest.json, a
// VRM file per part, thumbnails and textures. The website builds avatars from these files; the video renderer copies
// the files an avatar uses.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import { parsePack, type PackManifest } from '@casperaki/video/avatar';

export interface AvatarPack {
  /** The pack's folder name, as recipes name it ("drophunter"). */
  readonly name: string;
  readonly title: string;
  /** The pack's icon, a path inside the pack. */
  readonly thumbnail: string;
  readonly manifest: PackManifest;
  /** The manifest as written (what the website is sent). */
  readonly raw: unknown;
}

export class AvatarPacks {
  readonly root: string;
  private cache: Map<string, AvatarPack> | null = null;

  constructor(root: string) {
    this.root = resolve(root);
    if (!existsSync(this.root)) throw new Error(`avatar packs: BRAIN_AVATAR_PACKS_DIR ${this.root} does not exist`);
  }

  /** Every pack (each sub-folder with a manifest.json), read once; an error names a broken manifest. */
  list(): AvatarPack[] {
    if (!this.cache) {
      const packs = new Map<string, AvatarPack>();
      for (const name of readdirSync(this.root).sort()) {
        const file = join(this.root, name, 'manifest.json');
        if (!/^[a-z0-9_-]+$/u.test(name) || !existsSync(file)) continue;
        const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
        const manifest = parsePack(raw, name);
        const thumb = typeof raw.thumbnail === 'string' ? raw.thumbnail : undefined;
        const marker = `/${name}/`;
        if (!thumb || !thumb.includes(marker)) throw new Error(`avatar pack "${name}": its manifest's thumbnail "${thumb ?? ''}" is not inside the pack`);
        packs.set(name, { name, title: name[0]!.toUpperCase() + name.slice(1), thumbnail: thumb.slice(thumb.lastIndexOf(marker) + marker.length), manifest, raw });
      }
      if (packs.size === 0) throw new Error(`avatar packs: ${this.root} holds no pack (a folder with a manifest.json)`);
      this.cache = packs;
    }
    return [...this.cache.values()];
  }

  get(name: string): AvatarPack | undefined {
    return this.list().find((p) => p.name === name);
  }

  /** The absolute path of a file inside a pack, or undefined when the pack or file does not exist or the path leaves
   *  the pack. */
  file(pack: string, path: string): string | undefined {
    const p = this.get(pack);
    if (!p) return undefined;
    const dir = join(this.root, p.name);
    const abs = resolve(dir, path);
    if (!abs.startsWith(dir + sep)) return undefined;
    if (!existsSync(abs) || !statSync(abs).isFile()) return undefined;
    return abs;
  }
}
