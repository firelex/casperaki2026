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
 *   GET    /api/songs/:id/render.{mp3,wav}[?download=1]             mastered
 *   GET    /api/songs/:id/render-unmastered.{mp3,wav}[?download=1]  unmastered
 *   GET    /api/songs/:id/render/peaks?bins=
 */

import type { MixOverrides, Song } from '@casperaki/song-schema';
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
  readonly step?: 'lower' | 'render' | 'master' | 'encode';
  readonly queuePosition?: number;
  readonly error?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  /** Matchering-mastered (the default download and playback file). */
  readonly mp3Url?: string;
  readonly wavUrl?: string;
  /** The raw mix before mastering; absent on renders made before the split. */
  readonly unmasteredMp3Url?: string;
  readonly unmasteredWavUrl?: string;
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
  /** The owner's Pro-mode mix changes (null = the standard mix). */
  readonly mixOverrides: MixOverrides | null;
  readonly mixUpdatedAt: string | null;
  /** The song's lyrics while the brain writes them in the background, or why writing them failed (null = written). */
  readonly lyrics: ProjectLyrics | null;
  /** The song's artwork, drawn in the background after its title (null: none, the brain has no image service). */
  readonly artwork: ProjectArtwork | null;
  readonly render: RenderInfo;
}

export type ProjectArtwork =
  | { readonly state: 'drawing' }
  | { readonly state: 'done'; readonly url: string }
  | { readonly state: 'failed'; readonly message: string };

export type ProjectLyrics = { readonly state: 'writing' } | { readonly state: 'failed'; readonly message: string };

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

  /** Pro mode: save the song's mix changes (null = back to the standard mix). */
  saveMix(id: string, mixOverrides: MixOverrides | null): Promise<{ project: Project }> {
    return this.client.put<{ project: Project }>(`${songPath(id)}/mix`, { mixOverrides });
  }

  rename(id: string, title: string): Promise<{ project: Project }> {
    return this.client.patch<{ project: Project }>(songPath(id), { title });
  }

  remove(id: string): Promise<void> {
    return this.client.delete(songPath(id));
  }

  /** Writes the song's lyrics again after writing them failed (in the background; announced on /api/events). */
  retryLyrics(id: string): Promise<{ project: Project }> {
    return this.client.post<{ project: Project }>(`${songPath(id)}/lyrics`, {});
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
      return r.step === 'lower' ? 'preparing…' : r.step === 'master' ? 'mastering…' : r.step === 'encode' ? 'encoding…' : 'rendering…';
    case 'done':
      return 'rendered';
    case 'failed':
      return 'render failed';
  }
}
