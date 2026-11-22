import { defaultBrainClient } from './client';

export type VideoOrientation = 'landscape' | 'portrait';

/** One music-video job of a song (per orientation). */
export interface VideoStatus {
  readonly state: 'queued' | 'running' | 'done' | 'failed';
  /** What it is doing: 'audio' (exporting the mix), 'planning', 'rendering'. */
  readonly step?: string;
  /** 0..1 while rendering, when known. */
  readonly progress?: number;
  readonly error?: string;
  /** When done: the MP4. */
  readonly url?: string;
  readonly finishedAt?: string;
}

export interface VideoJobs {
  readonly jobs: Partial<Record<VideoOrientation, VideoStatus>>;
  /** Whether the scene planner (a language model) is set up on the brain. */
  readonly plannerConfigured: boolean;
}

export const videoQueryKeys = { jobs: (songId: string) => ['video', songId] as const };

export const videoApi = {
  jobs: (songId: string, signal?: AbortSignal) => defaultBrainClient.get<VideoJobs>(`/api/songs/${encodeURIComponent(songId)}/video`, { signal }),
  /** Make a music video of the saved song (its exported mix is made first if needed). */
  start: (songId: string, orientation: VideoOrientation, artist: string) =>
    defaultBrainClient.post<VideoStatus>(`/api/songs/${encodeURIComponent(songId)}/video`, { orientation, artist }),
};
