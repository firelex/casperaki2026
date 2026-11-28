import { defaultBrainClient } from './client';

export type VideoOrientation = 'landscape' | 'portrait';
/** A video of a song: wide or tall, full size or a half-size quick preview. */
export type VideoFormat = VideoOrientation | `${VideoOrientation}-preview`;
export type VideoQuality = 'full' | 'preview';
/** The levels measured in the browser for one version of the song (src/editor/trackLevels.ts): the master's and each
 *  mixer strip's peak level per bin, with the strip's role (the lead vocal's drive the singer's mouth). The brain adds
 *  the song's timing, words and audio. */
export interface MeasuredLevels {
  readonly versionKey: string;
  readonly binSeconds: number;
  readonly master: readonly number[];
  readonly tracks: readonly { readonly name: string; readonly role: 'track' | 'leadVocal' | 'effects'; readonly levels: readonly number[] }[];
}

/** One music-video job of a song (per orientation). */
export interface VideoStatus {
  readonly state: 'queued' | 'running' | 'done' | 'failed';
  /** What it is doing: 'audio' (exporting the mix), 'rendering'. */
  readonly step?: string;
  /** Progress of the current step, 0..1 (rendering: frames). */
  readonly progress?: number;
  /** What exactly is happening, in plain words. */
  readonly detail?: string;
  /** When the current step began. */
  readonly stepStartedAt?: string;
  readonly startedAt?: string;
  readonly error?: string;
  /** When done: the MP4. */
  readonly url?: string;
  readonly finishedAt?: string;
}

/** The song's videos: the 3D avatar video's job per format. */
export interface VideoJobs {
  readonly jobs: { readonly avatars: Partial<Record<VideoFormat, VideoStatus>> };
}

/** What starting a video takes. */
export interface VideoStart {
  readonly orientation: VideoOrientation;
  readonly quality: VideoQuality;
  readonly artist: string;
  readonly levels: MeasuredLevels;
  readonly avatarIds: readonly string[];
  readonly storyboard?: readonly { scene: string; avatarIds: readonly string[]; camera: string }[];
}

/** The request body for starting a video (apps/brain/src/routes/video.ts). */
export function videoStartBody(o: VideoStart) {
  return {
    orientation: o.orientation,
    quality: o.quality,
    artist: o.artist,
    levels: o.levels,
    avatars: { avatarIds: o.avatarIds, ...(o.storyboard ? { storyboard: o.storyboard } : {}) },
  };
}

export const videoQueryKeys = { jobs: (songId: string) => ['video', songId] as const };

export const videoApi = {
  jobs: (songId: string, signal?: AbortSignal) => defaultBrainClient.get<VideoJobs>(`/api/songs/${encodeURIComponent(songId)}/video`, { signal }),
  /** Make the 3D avatar video of the saved song (its exported mix is made first if needed), with the levels measured
   *  for the saved version. */
  start: (songId: string, o: VideoStart) => defaultBrainClient.post<VideoStatus>(`/api/songs/${encodeURIComponent(songId)}/video`, videoStartBody(o)),
};
