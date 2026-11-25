/**
 * Brain `tasks` API — matches `apps/brain/src/routes/tasks.ts`: background tasks on the user's songs.
 *
 *   GET  /api/tasks                         unfinished tasks and those finished in the last day
 *   POST /api/tasks { kind, songId, song }  start one (song = the editor's working copy)
 *   POST /api/tasks/:id/apply               a ready result saved into the song: its new id
 *   POST /api/tasks/:id/retry               a failed task started again
 */

import type { Song } from '@casperaki/song-schema';

import { defaultBrainClient } from './client';

export type TaskKind = 'writeLyrics';
export type TaskState = 'running' | 'ready' | 'done' | 'failed';

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
  retry: (id: string) => defaultBrainClient.post<{ task: BackgroundTask }>(`/api/tasks/${encodeURIComponent(id)}/retry`, {}),
};

/** What a task does, in words ("Write lyrics"). */
export const TASK_LABELS: Readonly<Record<TaskKind, string>> = { writeLyrics: 'Write lyrics' };
