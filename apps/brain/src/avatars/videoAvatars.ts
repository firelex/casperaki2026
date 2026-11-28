// The avatars a dance floor video shows (all of one style): the owner's avatars by id, in the order chosen, and the lead: the first of
// them whose voice is the singer of the song's latest finished Sing (it sings the song). Without such an avatar
// nobody sings and all dance.

import type { SongsStore } from '../store.js';
import { SingOptionsSchema } from '../tasks/tasks.js';
import { VideoInputError, type VideoAvatar } from '../video/videoInput.js';
import type { UserAvatars } from './userAvatars.js';

/** How many avatars a video can show (the engine's limit). */
export const MAX_VIDEO_AVATARS = 5;

/** The singer of the song's latest finished Sing, or undefined when it was never sung. */
export function songSinger(store: SongsStore, ownerId: string, songId: string): string | undefined {
  const sing = store.listTasks(ownerId, '').find((t) => t.kind === 'sing' && t.songId === songId && t.state === 'done');
  if (!sing) return undefined;
  const o = SingOptionsSchema.safeParse(sing.options);
  return o.success ? o.data.singerId : undefined;
}

export function videoAvatars(store: SongsStore, avatars: UserAvatars, ownerId: string, songId: string, ids: readonly string[]): VideoAvatar[] {
  if (ids.length === 0) throw new VideoInputError(400, 'no_avatars', 'Choose at least one avatar for the video.');
  if (ids.length > MAX_VIDEO_AVATARS) throw new VideoInputError(400, 'too_many_avatars', `A video shows at most ${MAX_VIDEO_AVATARS} avatars; ${ids.length} were chosen.`);
  if (new Set(ids).size !== ids.length) throw new VideoInputError(400, 'invalid_body', 'An avatar was chosen twice.');
  const mine = avatars.list(ownerId);
  const chosen = ids.map((id) => {
    const a = mine.find((x) => x.id === id);
    if (!a) throw new VideoInputError(400, 'unknown_avatar', `You have no avatar "${id}".`);
    return a;
  });
  // One style per video (anime and realistic side by side clash).
  if (new Set(chosen.map((a) => a.style)).size > 1) throw new VideoInputError(400, 'mixed_styles', 'A video uses avatars of one style: all anime or all realistic.');
  const singer = songSinger(store, ownerId, songId);
  const lead = singer === undefined ? -1 : chosen.findIndex((a) => a.singerId === singer);
  return chosen.map((a, i) =>
    a.style === 'anime' ? { id: a.id, name: a.name, recipe: a.recipe, sings: i === lead } : { id: a.id, name: a.name, vrm: avatars.vrmPath(ownerId, a.id), sings: i === lead },
  );
}
