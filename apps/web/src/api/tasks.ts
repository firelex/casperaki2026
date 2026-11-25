/**
 * Brain `tasks` API — matches `apps/brain/src/routes/tasks.ts`: background tasks on the user's songs.
 *
 *   GET  /api/tasks                         unfinished tasks and those finished in the last day
 *   POST /api/tasks { kind, songId, song }  start one (song = the editor's working copy)
 *   POST /api/tasks/:id/apply               a ready result saved into the song: its new id
 *   POST /api/tasks/:id/retry               a failed task started again
 *   POST /api/tasks/:id/cancel              a running task cancelled (it fails with "Cancelled")
 *   GET  /api/tasks/:id/files/:stage/:name  a file a step made (sing)
 */

import type { Song } from '@casperaki/song-schema';

import { defaultBrainClient } from './client';

export type TaskKind = 'writeLyrics' | 'sing';
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
  /** The project's current song. */
  readonly songId: string;
  /** The song's title. */
  readonly title: string;
  readonly state: TaskState;
  /** Why it failed. */
  readonly message?: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly steps?: readonly TaskStep[];
}

export interface AppliedTask {
  readonly task: BackgroundTask;
  /** The saved version's id. */
  readonly songId: string;
  /** What the task made (writeLyrics: section → lines). */
  readonly result: Readonly<Record<string, readonly string[]>>;
}

export const tasksQueryKey = ['tasks'] as const;

export const tasksApi = {
  list: (signal?: AbortSignal) => defaultBrainClient.get<{ tasks: BackgroundTask[] }>('/api/tasks', { signal }),
  start: (kind: TaskKind, songId: string, song: Song) => defaultBrainClient.post<{ task: BackgroundTask }>('/api/tasks', { kind, songId, song }),
  apply: (id: string) => defaultBrainClient.post<AppliedTask>(`/api/tasks/${encodeURIComponent(id)}/apply`, {}),
  cancel: (id: string) => defaultBrainClient.post<{ task: BackgroundTask }>(`/api/tasks/${encodeURIComponent(id)}/cancel`, {}),
  /** Where a step's file ("<stage>/<name>") is served. */
  fileUrl: (id: string, entry: string) => `/api/tasks/${encodeURIComponent(id)}/files/${entry.split('/').map(encodeURIComponent).join('/')}`,
  retry: (id: string) => defaultBrainClient.post<{ task: BackgroundTask }>(`/api/tasks/${encodeURIComponent(id)}/retry`, {}),
};

/** What a task does, in words ("Write lyrics"). */
export const TASK_LABELS: Readonly<Record<TaskKind, string>> = { writeLyrics: 'Write lyrics', sing: 'Sing' };
