/**
 * Brain `avatars` API — matches `apps/brain/src/routes/avatars.ts`: the avatar part packs (Character Studio packs,
 * each with its manifest; their files are served under /api/avatar-packs/<pack>/<path>) and the user's avatars
 * (a recipe, a name, the singer whose voice it has, and a portrait).
 */
import { parsePack, type AvatarRecipe, type PackManifest } from '@casperaki/video/avatar';

import type { AvatarStyle, RealisticDesign, RealisticLibraryInfo } from '../avatars/realisticDesign';
import type { BackgroundTask } from './tasks';
import { defaultBrainClient } from './client';

export interface AvatarPackInfo {
  /** The pack's folder name, e.g. "drophunter" (the recipe's `pack`). */
  readonly name: string;
  readonly title: string;
  readonly thumbnailUrl: string;
  readonly manifest: PackManifest;
}

export interface AvatarInfo {
  readonly id: string;
  /** Anime (a recipe of pack parts) or realistic (a MakeHuman design and its built VRM). */
  readonly style: AvatarStyle;
  readonly name: string;
  /** Anime avatars. */
  readonly recipe?: AvatarRecipe;
  /** Realistic avatars: the design, and the URL of the built person. */
  readonly design?: RealisticDesign;
  readonly vrmUrl?: string;
  /** Realistic avatars: the CC-BY assets they use, to credit. */
  readonly credits?: readonly { readonly name: string; readonly author: string; readonly licence: string }[];
  readonly singerId: string | null;
  readonly portraitUrl: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** What New avatar and Save send: the portrait is a PNG data URL taken from the 3D view. */
export interface AvatarForm {
  readonly name: string;
  readonly recipe: AvatarRecipe;
  readonly singerId: string | null;
  readonly portrait: string;
}

/** What Save sends for a realistic avatar: the finished build to keep, and a portrait from the 3D view. */
export interface RealisticAvatarForm {
  readonly name: string;
  readonly singerId: string | null;
  readonly buildTaskId: string;
  readonly portrait: string;
}

export const realisticLibraryQueryKey = ['realistic-avatar-library'] as const;

/** The URL of a file in a pack (a path relative to the pack folder, as the manifest writes it). */
export function packFileUrl(pack: string, path: string): string {
  const clean = path.replace(/^\.\//u, '');
  return `/api/avatar-packs/${encodeURIComponent(pack)}/${clean.split('/').map(encodeURIComponent).join('/')}`;
}

export const avatarPacksQueryKey = ['avatar-packs'] as const;
export const avatarsQueryKey = ['avatars'] as const;

interface RawPack {
  readonly name: string;
  readonly title: string;
  readonly thumbnailUrl: string;
  readonly manifest: unknown;
}

export const avatarsApi = {
  /** The packs, each manifest checked (a pack whose manifest is not a Character Studio manifest throws, naming it). */
  packs: async (signal?: AbortSignal): Promise<AvatarPackInfo[]> => {
    const { packs } = await defaultBrainClient.get<{ packs: RawPack[] }>('/api/avatar-packs', { signal });
    return packs.map((p) => ({ name: p.name, title: p.title, thumbnailUrl: p.thumbnailUrl, manifest: parsePack(p.manifest, p.name) }));
  },
  list: (signal?: AbortSignal) => defaultBrainClient.get<{ avatars: AvatarInfo[] }>('/api/avatars', { signal }),
  create: (f: AvatarForm) => defaultBrainClient.post<{ avatar: AvatarInfo }>('/api/avatars', f),
  update: (id: string, f: AvatarForm) => defaultBrainClient.put<{ avatar: AvatarInfo }>(`/api/avatars/${encodeURIComponent(id)}`, f),
  /** Realistic avatars (admins): the curated library, a build of a design (a background task), saving a build. */
  realisticLibrary: (signal?: AbortSignal) => defaultBrainClient.get<{ library: RealisticLibraryInfo }>('/api/avatars/realistic/library', { signal }),
  build: (design: RealisticDesign) => defaultBrainClient.post<{ task: BackgroundTask }>('/api/avatars/realistic/builds', { design }),
  buildVrmUrl: (taskId: string) => `/api/avatars/realistic/builds/${encodeURIComponent(taskId)}/vrm`,
  createRealistic: (f: RealisticAvatarForm) => defaultBrainClient.post<{ avatar: AvatarInfo }>('/api/avatars/realistic', f),
  updateRealistic: (id: string, f: RealisticAvatarForm) => defaultBrainClient.put<{ avatar: AvatarInfo }>(`/api/avatars/realistic/${encodeURIComponent(id)}`, f),
  remove: (id: string) => defaultBrainClient.delete<{ deleted: string }>(`/api/avatars/${encodeURIComponent(id)}`),
};
