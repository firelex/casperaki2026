/**
 * Brain `tasks` API — matches `apps/brain/src/routes/tasks.ts`: background tasks on the user's songs.
 *
 *   GET  /api/tasks                         unfinished tasks and those finished in the last day
 *   POST /api/tasks { kind, songId, song }  start one (song = the editor's working copy)
 *   POST /api/tasks { kind: 'transcribe', songId, song, segment, recording: { name, type, data }, hasBacking }
 *                                           Transcribe melody: a recording of one section (data: base64, at most
 *                                           10 MB), sung or hummed along from the section's first beat
 *   POST /api/tasks { kind: 'aceLayer', songId, song, instrument, words?, range?: { startBar, endBar }, sectionKinds?: [kind] }
 *                                           Add ACE layer: one instrument part ACE-Step plays over the song (or the
 *                                           selected bars), on an audio-only track "ACE <Instrument>"
 *   POST /api/tasks/:id/apply               a ready result saved into the song: its new id
 *   POST /api/tasks/:id/retry               a failed task started again
 *   POST /api/tasks/:id/cancel              a running task cancelled (it fails with "Cancelled")
 *   GET  /api/tasks/:id/files/:stage/:name  a file a step made (sing)
 * Add a singer is started by POST /api/singers (api/singers.ts); its task is on no song (songId null) and is done,
 * not applied, when the singer is stored.
 */

import type { Song } from '@casperaki/song-schema';
import type { AceAdlibVoice, AceInstrument } from '@casperaki/song-schema/ace-layer';

import { defaultBrainClient } from './client';

export type TaskKind = 'writeLyrics' | 'sing' | 'transcribe' | 'aceLayer' | 'addSinger';
export type TaskState = 'running' | 'ready' | 'done' | 'failed';

/** One step of a task (sing records every one), as the brain stores it. */
export interface TaskStep {
  readonly id: string;
  readonly label: string;
  readonly state: 'waiting' | 'running' | 'done' | 'failed';
  readonly startedAt?: string;
  readonly finishedAt?: string;
  /** What the step found, or why it failed. */
  readonly text?: string;
  readonly numbers?: Readonly<Record<string, number>>;
  /** Files the step made, each "<stage>/<name>" (see `tasksApi.fileUrl`). */
  readonly files?: readonly string[];
}

export interface BackgroundTask {
  readonly id: string;
  readonly kind: TaskKind;
  /** The project's current song; null for Add a singer (on no song). */
  readonly songId: string | null;
  /** The song's title (Add a singer: the singer's name). */
  readonly title: string;
  readonly state: TaskState;
  /** Why it failed. */
  readonly message?: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly steps?: readonly TaskStep[];
  /** Sing: the singer it sang with; Add a singer: the singer it makes. */
  readonly singerId?: string;
}

export interface AppliedTask {
  readonly task: BackgroundTask;
  /** The saved version's id. */
  readonly songId: string;
  /** What the task made (writeLyrics: section → lines; sing: the sung melody and takes). */
  readonly result: unknown;
}

export const tasksQueryKey = ['tasks'] as const;

export const tasksApi = {
  list: (signal?: AbortSignal) => defaultBrainClient.get<{ tasks: BackgroundTask[] }>('/api/tasks', { signal }),
  start: (kind: 'writeLyrics', songId: string, song: Song) => defaultBrainClient.post<{ task: BackgroundTask }>('/api/tasks', { kind, songId, song }),
  /** Sing with a singer (singersApi.list). */
  startSing: (songId: string, song: Song, singerId: string) => defaultBrainClient.post<{ task: BackgroundTask }>('/api/tasks', { kind: 'sing', songId, song, singerId }),
  /** Transcribe melody: `recording.data` is the file as base64. */
  startTranscribe: (songId: string, song: Song, segment: string, recording: { name: string; type: string; data: string }, hasBacking: boolean) =>
    defaultBrainClient.post<{ task: BackgroundTask }>('/api/tasks', { kind: 'transcribe', songId, song, segment, recording, hasBacking }),
  /** Add ACE layer: `range` in bars from the song's start (end exclusive); none = the whole song. */
  startAceLayer: (songId: string, song: Song, instrument: AceInstrument, words: string, range: { startBar: number; endBar: number } | undefined, sectionKinds: string[] | undefined) =>
    defaultBrainClient.post<{ task: BackgroundTask }>('/api/tasks', {
      kind: 'aceLayer', songId, song, instrument,
      ...(words.trim() ? { words: words.trim() } : {}), ...(range ? { range } : {}), ...(sectionKinds ? { sectionKinds } : {}),
    }),
  /** Add ad-libs: ACE sings `lyrics` (under every chorus) in `style` on the chosen voice; clips only in `sections`. */
  startAdlibs: (songId: string, song: Song, lyrics: string, style: string, voice: AceAdlibVoice, sections: readonly string[]) =>
    defaultBrainClient.post<{ task: BackgroundTask }>('/api/tasks', {
      kind: 'aceLayer', songId, song, instrument: 'adlibs', lyrics, voice, sections,
      ...(style.trim() ? { words: style.trim() } : {}),
    }),
  /** Add rap vocals: ACE raps in `style` over `sections`; `rapWords` holds the words the user wrote (the other
   *  sections' words are written by the brain). */
  startRap: (songId: string, song: Song, style: string, sections: readonly string[], rapWords: Record<string, string>) =>
    defaultBrainClient.post<{ task: BackgroundTask }>('/api/tasks', {
      kind: 'aceLayer', songId, song, instrument: 'rap', sections,
      ...(style.trim() ? { words: style.trim() } : {}), ...(Object.keys(rapWords).length ? { rapWords } : {}),
    }),
  apply: (id: string) => defaultBrainClient.post<AppliedTask>(`/api/tasks/${encodeURIComponent(id)}/apply`, {}),
  cancel: (id: string) => defaultBrainClient.post<{ task: BackgroundTask }>(`/api/tasks/${encodeURIComponent(id)}/cancel`, {}),
  /** Where a step's file ("<stage>/<name>") is served. */
  fileUrl: (id: string, entry: string) => `/api/tasks/${encodeURIComponent(id)}/files/${entry.split('/').map(encodeURIComponent).join('/')}`,
  retry: (id: string) => defaultBrainClient.post<{ task: BackgroundTask }>(`/api/tasks/${encodeURIComponent(id)}/retry`, {}),
};

/** What a task does, in words ("Write lyrics"). */
export const TASK_LABELS: Readonly<Record<TaskKind, string>> = { writeLyrics: 'Write lyrics', sing: 'Sing', transcribe: 'Transcribe melody', aceLayer: 'Add ACE layer', addSinger: 'Add a singer' };
