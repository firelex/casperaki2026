import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';

import type { Song } from '@casperaki/song-schema';

import { songsApi, songsQueryKeys, type GeneratedSong } from '../api/songs';
import { tasksApi, tasksQueryKey, type AppliedTask, type BackgroundTask } from '../api/tasks';
import { tracksApi, type TrackEdit } from '../api/tracks';
import type { LiveStatus } from '../audio/livePlayer';
import { useLiveState } from '../audio/useLivePlayer';
import { useSession } from './session';

/**
 * Background tasks on the user's songs (apps/brain/src/tasks/tasks.ts): the list, and applying finished results.
 *
 * A finished task's result waits in the brain ("ready") until a page applies it, and pages apply results only while
 * nothing is playing, so a song never changes under playback
 * (docs/superpowers/specs/2026-11-25-vocal-tasks-design.md). While a result goes into the song open in the editor, an
 * hourglass covers the page.
 */

/** The user's tasks; polled every few seconds while one is running or ready, refreshed on the brain's task events. */
export function useTasks() {
  return useQuery({
    queryKey: tasksQueryKey,
    queryFn: ({ signal }) => tasksApi.list(signal).then((r) => r.tasks),
    refetchInterval: (q) => ((q.state.data ?? []).some((t) => t.state === 'running' || t.state === 'ready') ? 5000 : false),
  });
}

/** Whether a task's result goes into its song now: it is ready and nothing is playing (or loading to play). */
export function shouldApply(task: BackgroundTask, player: LiveStatus): boolean {
  return task.state === 'ready' && player !== 'playing' && player !== 'loading';
}

/** What applying a result needs: the session's parts, the brain and the router. */
export interface ApplyContext {
  readonly activeSong: GeneratedSong | undefined;
  readonly editorDirty: boolean;
  readonly viewSong: Song | undefined;
  readonly pathname: string;
  apply(id: string): Promise<AppliedTask>;
  getSong(id: string): Promise<GeneratedSong>;
  /** The working song with the result put in (the brain's applyLyrics / applySung edit). */
  mergeResult(song: Song, kind: BackgroundTask['kind'], result: AppliedTask['result'], saved: Song): Promise<Song>;
  setActiveSong(song: GeneratedSong): void;
  applyEdit(command: { kind: 'replaceSong'; song: Song }): void;
  cacheSong(saved: GeneratedSong, oldId: string): void;
  navigate(path: string): void;
  refresh(): void;
}

/** The track edit that puts a task's result into a working song: written lyrics, or a sung result (Transcribe
 *  melody's covers its section only: `partial`, so the other sections keep their takes). */
export function mergeOp(kind: BackgroundTask['kind'], result: AppliedTask['result'], saved: Song): TrackEdit {
  if (kind === 'sing') return { kind: 'applySung', result, sungOver: saved };
  if (kind === 'transcribe') return { kind: 'applySung', result, sungOver: saved, partial: true };
  if (kind === 'aceLayer') return { kind: 'applyAceLayer', result };
  return { kind: 'applyLyrics', lyrics: result as Readonly<Record<string, readonly string[]>> };
}

/**
 * Applies a ready task: the brain saves the result into the song as a new version. When that song is open in the
 * editor, the editor switches to the new version; unsaved edits stay, with the result put into them too.
 */
export async function applyReadyTask(task: BackgroundTask, c: ApplyContext): Promise<void> {
  const open = c.activeSong?.id === task.songId;
  const applied = await c.apply(task.id);
  if (open) {
    const saved = await c.getSong(applied.songId);
    const merged = c.editorDirty && c.viewSong ? await c.mergeResult(c.viewSong, task.kind, applied.result, saved.song) : undefined;
    c.setActiveSong(saved);
    if (merged) c.applyEdit({ kind: 'replaceSong', song: merged });
    c.cacheSong(saved, task.songId);
    if (c.pathname.includes(`/editor/${task.songId}`)) c.navigate(c.pathname.replace(`/editor/${task.songId}`, `/editor/${applied.songId}`));
  }
  c.refresh();
}

// ---- what is being applied (the hourglass), and what failed --------------------------------------------------------

interface ApplyingState {
  /** The song whose result is going in, while it does. */
  readonly songId: string | undefined;
  /** Per ready task whose result could not go in: why. It is not tried again until the user asks (Tasks menu). */
  readonly failed: Readonly<Record<string, string>>;
}

let applying: ApplyingState = { songId: undefined, failed: {} };
const listeners = new Set<() => void>();
function setApplying(next: ApplyingState) {
  applying = next;
  for (const l of listeners) l();
}

/** Lets a ready task whose result could not go in try again. */
export function tryApplyAgain(taskId: string): void {
  const { [taskId]: _gone, ...failed } = applying.failed;
  setApplying({ ...applying, failed });
}

export function useApplying(): ApplyingState {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => applying,
  );
}

/** Applies the user's ready tasks whenever nothing is playing (mounted once, inside the session and the router). */
export function useApplyReadyTasks(): void {
  const session = useSession();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const player = useLiveState();
  const { data: tasks } = useTasks();
  const { failed } = useApplying();
  const latest = useRef({ session, location });
  latest.current = { session, location };
  const busy = useRef(false);

  useEffect(() => {
    if (busy.current) return;
    const next = (tasks ?? []).find((t) => shouldApply(t, player.status) && !failed[t.id]);
    if (!next) return;
    busy.current = true;
    const { session: s, location: loc } = latest.current;
    const open = s.activeSong?.id === next.songId;
    setApplying({ ...applying, songId: open ? next.songId : undefined });
    void applyReadyTask(next, {
      activeSong: s.activeSong,
      editorDirty: s.editorDirty,
      viewSong: s.viewSong,
      pathname: loc.pathname,
      apply: (id) => tasksApi.apply(id),
      getSong: (id) => songsApi.get(id),
      mergeResult: async (song, kind, result, saved) => (await tracksApi.edit(song, mergeOp(kind, result, saved))).song,
      setActiveSong: s.setActiveSong,
      applyEdit: s.applyEdit,
      cacheSong: (saved, oldId) => {
        queryClient.setQueryData(songsQueryKeys.song(saved.id), saved);
        queryClient.removeQueries({ queryKey: songsQueryKeys.song(oldId) });
      },
      navigate: (path) => navigate(path, { replace: true }),
      refresh: () => {
        void queryClient.invalidateQueries({ queryKey: tasksQueryKey });
        void queryClient.invalidateQueries({ queryKey: songsQueryKeys.list });
      },
    }).then(
      () => setApplying({ ...applying, songId: undefined }),
      (err: unknown) => {
        const message = `Could not go into the song: ${err instanceof Error ? err.message : String(err)}`;
        console.error(`[tasks] ${next.kind} ${next.id}: ${message}`);
        setApplying({ songId: undefined, failed: { ...applying.failed, [next.id]: message } });
        void queryClient.invalidateQueries({ queryKey: tasksQueryKey });
      },
    ).finally(() => {
      busy.current = false;
    });
  }, [tasks, player.status, queryClient, navigate, failed]);
}

/** The hourglass over the page while a result goes into the open song. */
export function ApplyingOverlay() {
  const { songId } = useApplying();
  if (!songId) return null;
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50" role="status" aria-live="polite">
      <div className="flex items-center gap-3 rounded-[10px] border border-line bg-panel px-5 py-4 text-[15px] text-white shadow-2xl">
        <span className="animate-pulse text-[22px]" aria-hidden>
          ⏳
        </span>
        Updating the song…
      </div>
    </div>
  );
}

/** Seconds since `iso`, refreshed every second while `active`. */
export function useElapsed(iso: string, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
}
