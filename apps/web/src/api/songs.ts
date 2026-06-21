/**
 * Brain `songs` API.
 *
 * Matches the three endpoints exposed by `apps/brain/src/routes/songs.ts`:
 *   POST /api/songs/generate
 *   GET  /api/songs/:id
 *   POST /api/songs/:id/replay
 *
 * No backend APIs are invented here. If the workbench needs more (catalog,
 * jobs, artifacts) it should land in the brain first.
 */

import type { Song } from '@casperaki/song-schema';
import { BrainClient, defaultBrainClient } from './client';

export interface GenerateRequest {
  readonly genre: string;
  readonly key: string;
  readonly bpm: number;
  readonly seed: string | number;
  readonly params?: Record<string, unknown>;
}

export interface GeneratedSong {
  readonly id: string;
  readonly song: Song;
  readonly hash: string;
}

export interface ReplayResult {
  readonly id: string;
  readonly ok: boolean;
  readonly hash: string;
  readonly replayHash: string;
}

export class SongsApi {
  constructor(private readonly client: BrainClient = defaultBrainClient) {}

  generate(body: GenerateRequest, signal?: AbortSignal): Promise<GeneratedSong> {
    return this.client.post<GeneratedSong>('/api/songs/generate', body, { signal });
  }

  get(id: string, signal?: AbortSignal): Promise<GeneratedSong> {
    return this.client.get<GeneratedSong>(`/api/songs/${encodeURIComponent(id)}`, { signal });
  }

  replay(id: string, signal?: AbortSignal): Promise<ReplayResult> {
    return this.client.post<ReplayResult>(
      `/api/songs/${encodeURIComponent(id)}/replay`,
      {},
      { signal },
    );
  }
}

export const songsApi = new SongsApi();

/** TanStack Query keys, centralised so cache invalidation has one source. */
export const songsQueryKeys = {
  song: (id: string) => ['song', id] as const,
};
