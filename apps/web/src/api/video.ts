import { defaultBrainClient } from './client';

export type VideoOrientation = 'landscape' | 'portrait';
/** A video of a song: wide or tall, full size or a half-size quick preview. */
export type VideoFormat = VideoOrientation | `${VideoOrientation}-preview`;
export type VideoQuality = 'full' | 'preview';
/** 'cartoon': dancers and scenes planned by a language model. 'console': a 3D mixing desk driven by the tracks.
 *  'avatars': the user's avatars dancing on a 3D dance floor, the lead singing. */
export type VideoStyle = 'cartoon' | 'console' | 'avatars';

/** An automation curve sampled every `step` seconds from `t0`. */
export interface ConsoleAutomation {
  readonly t0: number;
  readonly step: number;
  readonly values: readonly number[];
}

/** One mixer strip as the console video draws it (the engine's ConsoleTrack, casperaki-video src/schema/console.ts). */
export interface ConsoleBodyTrack {
  readonly name: string;
  readonly role: 'track' | 'leadVocal' | 'effects';
  /** #rrggbb; absent for effects strips. */
  readonly color?: string;
  readonly bus: string;
  /** null: the strip's parts differ (a drum kit), the fader sits at 0 dB. */
  readonly volumeDb: number | null;
  /** Send levels to the reverb, delay and chorus returns, dB (null: none). */
  readonly sends: { readonly reverb: number | null; readonly delay: number | null; readonly chorus: number | null };
  /** Peak level per bin. */
  readonly levels: readonly number[];
  readonly volumeAutomation?: ConsoleAutomation;
  readonly lowPassAutomation?: ConsoleAutomation;
  readonly clips: readonly {
    readonly section: string;
    readonly startSeconds: number;
    readonly endSeconds: number;
    readonly notes: readonly { readonly startSeconds: number; readonly lengthSeconds: number; readonly pitch: number | null; readonly velocity: number | null }[];
  }[];
}

/** The tracks measured for one version of the song (the brain adds the song's timing and audio). */
export interface ConsoleBody {
  readonly versionKey: string;
  readonly binSeconds: number;
  readonly tracks: readonly ConsoleBodyTrack[];
  readonly master: readonly number[];
}

/** One music-video job of a song (per orientation). */
export interface VideoStatus {
  readonly state: 'queued' | 'running' | 'done' | 'failed';
  /** What it is doing: 'audio' (exporting the mix), 'planning', 'rendering'. */
  readonly step?: string;
  /** Progress of the current step, 0..1 (planning: shots written; rendering: frames). */
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

export interface VideoJobs {
  readonly jobs: Record<VideoStyle, Partial<Record<VideoFormat, VideoStatus>>>;
  /** Whether the scene planner (a language model) is set up on the brain. */
  readonly plannerConfigured: boolean;
}

export const videoQueryKeys = { jobs: (songId: string) => ['video', songId] as const };

export const videoApi = {
  jobs: (songId: string, signal?: AbortSignal) => defaultBrainClient.get<VideoJobs>(`/api/songs/${encodeURIComponent(songId)}/video`, { signal }),
  /** Make a music video of the saved song (its exported mix is made first if needed). The console style sends the
   *  tracks measured for the saved version. */
  start: (
    songId: string,
    opts: { style: VideoStyle; orientation: VideoOrientation; quality: VideoQuality; artist: string; console?: ConsoleBody; avatarIds?: readonly string[] },
  ) =>
    defaultBrainClient.post<VideoStatus>(`/api/songs/${encodeURIComponent(songId)}/video`, {
      style: opts.style,
      orientation: opts.orientation,
      quality: opts.quality,
      artist: opts.artist,
      ...(opts.console ? { console: opts.console } : {}),
      ...(opts.avatarIds ? { avatars: { avatarIds: opts.avatarIds } } : {}),
    }),
};
