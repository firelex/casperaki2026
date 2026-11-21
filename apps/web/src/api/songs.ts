/**
 * Brain `songs` API — matches `apps/brain/src/routes/songs.ts`:
 *
 *   GET    /api/songs                    the signed-in user's projects
 *   POST   /api/songs/generate           generate + add to projects
 *   GET    /api/songs/:id                one song (must be the user's)
 *   PUT    /api/songs/:id                save an edit (new content id)
 *   PATCH  /api/songs/:id                rename
 *   DELETE /api/songs/:id                remove from projects
 *   POST   /api/songs/:id/replay         determinism check
 *   POST   /api/songs/:id/render         queue a server-side render
 *   GET    /api/songs/:id/render         render status
 *   GET    /api/songs/:id/render.{mp3,wav}[?download=1]
 *   GET    /api/songs/:id/render/peaks?bins=
 */

import type { Song } from '@casperaki/song-schema';
import { BrainClient, defaultBrainClient } from './client';
import type { RenderPeaks } from './renders';

export interface GenerateRequest {
  readonly genre: string;
  readonly key: string;
  readonly bpm: number;
  readonly seed: string | number;
  readonly title?: string;
  readonly params?: Record<string, unknown>;
}

export type RenderState = 'none' | 'queued' | 'running' | 'done' | 'failed';

export interface RenderInfo {
  readonly state: RenderState;
  readonly step?: 'lower' | 'render' | 'encode';
  readonly queuePosition?: number;
  readonly error?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly mp3Url?: string;
  readonly wavUrl?: string;
}

export interface Project {
  readonly id: string;
  readonly title: string;
  readonly genre: string | null;
  readonly key: string;
  readonly bpm: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** The song's sections in order, for drawing its shape. */
  readonly sections: readonly ProjectSection[];
  readonly render: RenderInfo;
}

export interface ProjectSection {
  readonly name: string;
  /** The brain's section type tag (intro / verse / chorus / ...), if any. */
  readonly type: string | null;
  readonly bars: number;
}

export interface GeneratedSong {
  readonly id: string;
  readonly song: Song;
  readonly hash: string;
  readonly project: Project;
}

export interface ReplayResult {
  readonly id: string;
  readonly ok: boolean;
  readonly hash: string;
  readonly replayHash: string;
}

const songPath = (id: string) => `/api/songs/${encodeURIComponent(id)}`;

export class SongsApi {
  constructor(private readonly client: BrainClient = defaultBrainClient) {}

  list(signal?: AbortSignal): Promise<{ projects: Project[] }> {
    return this.client.get<{ projects: Project[] }>('/api/songs', { signal });
  }

  generate(body: GenerateRequest, signal?: AbortSignal): Promise<GeneratedSong> {
    return this.client.post<GeneratedSong>('/api/songs/generate', body, { signal });
  }

  get(id: string, signal?: AbortSignal): Promise<GeneratedSong> {
    return this.client.get<GeneratedSong>(songPath(id), { signal });
  }

  save(id: string, song: Song, title?: string): Promise<GeneratedSong> {
    return this.client.put<GeneratedSong>(songPath(id), title ? { song, title } : { song });
  }

  rename(id: string, title: string): Promise<{ project: Project }> {
    return this.client.patch<{ project: Project }>(songPath(id), { title });
  }

  remove(id: string): Promise<void> {
    return this.client.delete(songPath(id));
  }

  replay(id: string, signal?: AbortSignal): Promise<ReplayResult> {
    return this.client.post<ReplayResult>(`${songPath(id)}/replay`, {}, { signal });
  }

  render(id: string): Promise<RenderInfo> {
    return this.client.post<RenderInfo>(`${songPath(id)}/render`, {});
  }

  renderStatus(id: string, signal?: AbortSignal): Promise<RenderInfo> {
    return this.client.get<RenderInfo>(`${songPath(id)}/render`, { signal });
  }

  renderPeaks(id: string, bins: number, signal?: AbortSignal): Promise<RenderPeaks> {
    return this.client.get<RenderPeaks>(`${songPath(id)}/render/peaks?bins=${bins}`, { signal });
  }
}

export const songsApi = new SongsApi();

/** TanStack Query keys, centralised so cache invalidation has one source. */
export const songsQueryKeys = {
  list: ['songs'] as const,
  song: (id: string) => ['song', id] as const,
  render: (id: string) => ['song', id, 'render'] as const,
  peaks: (id: string, bins: number) => ['song', id, 'peaks', bins] as const,
};

/** True while a render is queued or running (poll until it settles). */
export function renderInFlight(r: RenderInfo | undefined): boolean {
  return r?.state === 'queued' || r?.state === 'running';
}

export function renderLabel(r: RenderInfo | undefined): string {
  switch (r?.state) {
    case undefined:
    case 'none':
      return 'not rendered';
    case 'queued':
      return r.queuePosition ? `queued (${r.queuePosition} ahead)` : 'queued';
    case 'running':
      return r.step === 'lower' ? 'preparing…' : r.step === 'encode' ? 'encoding…' : 'rendering…';
    case 'done':
      return 'rendered';
    case 'failed':
      return 'render failed';
  }
}
