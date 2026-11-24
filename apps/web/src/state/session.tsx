import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import type { Song } from '@casperaki/song-schema';

import type { GeneratedSong, ProjectLyrics, ReplayResult } from '../api/songs';
import {
  applyCommand,
  canRedo as canRedoEdit,
  canUndo as canUndoEdit,
  initEditState,
  type EditCommand,
  type EditState,
} from './song-edit';

/**
 * Session state.
 *
 * Holds the currently-active song and segment, the editor session and
 * the last replay outcome. The project list itself is server state
 * (GET /api/songs via TanStack Query), not held here.
 *
 * NOT the typed editor store described in docs/54 — that lands with M2
 * once mutations are real.
 */

export interface SessionState {
  readonly activeSong: GeneratedSong | undefined;
  readonly activeSegment: string | undefined;
  /** Currently-focused bar within `activeSegment`. Read-only highlight today. */
  readonly activeBarIndex: number | undefined;
  readonly lastReplay: ReplayResult | undefined;
  /** Editor session for the active Song. `undefined` outside the editor.
   *  The reducer holds an immutable copy of the brain-returned Song
   *  (`editor.original`) and the user's working copy (`editor.working`).
   *  Mutations land via `applyEdit`. See `state/song-edit.ts`. */
  readonly editor: EditState | undefined;
  /** The Song that views should render — the editor's working copy when
   *  an edit session exists, else the original. Existing read-only
   *  inspectors only need this; the id/hash come from `activeSong`. */
  readonly viewSong: Song | undefined;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly editorDirty: boolean;
  readonly renderStale: boolean;
  setActiveSong(song: GeneratedSong | undefined): void;
  /** The saved project's title changed (rename): keeps the edit session. */
  setActiveTitle(title: string): void;
  /** The saved project's background lyrics state changed (writing, failed): keeps the edit session. */
  setActiveLyrics(lyrics: ProjectLyrics | null): void;
  setActiveSegment(segmentName: string | undefined): void;
  setActiveBarIndex(barIndex: number | undefined): void;
  setLastReplay(result: ReplayResult | undefined): void;
  applyEdit(command: EditCommand): void;
}

const SessionContext = createContext<SessionState | undefined>(undefined);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [activeSong, setActiveSongState] = useState<GeneratedSong | undefined>(undefined);
  const [activeSegment, setActiveSegmentState] = useState<string | undefined>(undefined);
  const [activeBarIndex, setActiveBarIndexState] = useState<number | undefined>(undefined);
  const [lastReplay, setLastReplayState] = useState<ReplayResult | undefined>(undefined);
  const [editor, setEditorState] = useState<EditState | undefined>(undefined);

  const setActiveSong = useCallback((song: GeneratedSong | undefined) => {
    setActiveSongState(song);
    setLastReplayState(undefined);
    setActiveSegmentState(song?.song.songStructure[0]?.name);
    setActiveBarIndexState(undefined);
    // The brain-returned Song seeds a fresh edit session. Any in-flight
    // edits from a previous song are discarded — switching songs is the
    // explicit reset boundary.
    setEditorState(song ? initEditState(song.song) : undefined);
  }, []);

  const applyEdit = useCallback((command: EditCommand) => {
    setEditorState((current) => {
      if (!current) return current;
      const next = applyCommand(current, command);
      if (next === current) return current;
      // Keep the active segment selection valid through edits. If the
      // selected segment is gone (delete) or renamed, fall back to the
      // first segment in the new working structure so the inspector
      // stays populated.
      const names = next.working.songStructure.map((s) => s.name);
      setActiveSegmentState((prev) => {
        if (prev === undefined) return names[0];
        if (names.includes(prev)) return prev;
        return names[0];
      });
      setActiveBarIndexState((prev) => {
        if (prev === undefined) return prev;
        // If the bar index now points past the (possibly resized)
        // active segment, drop the highlight.
        return prev;
      });
      return next;
    });
  }, []);

  const setActiveTitle = useCallback((title: string) => {
    setActiveSongState((song) => (song ? { ...song, project: { ...song.project, title } } : song));
  }, []);

  const setActiveLyrics = useCallback((lyrics: ProjectLyrics | null) => {
    setActiveSongState((song) => (song ? { ...song, project: { ...song.project, lyrics } } : song));
  }, []);

  const setActiveSegment = useCallback((segmentName: string | undefined) => {
    setActiveSegmentState((prev) => {
      if (prev !== segmentName) setActiveBarIndexState(undefined);
      return segmentName;
    });
  }, []);

  const setActiveBarIndex = useCallback((barIndex: number | undefined) => {
    setActiveBarIndexState(barIndex);
  }, []);

  const setLastReplay = useCallback((result: ReplayResult | undefined) => {
    setLastReplayState(result);
  }, []);

  const viewSong = editor?.working ?? activeSong?.song;
  const canUndo = editor ? canUndoEdit(editor) : false;
  const canRedo = editor ? canRedoEdit(editor) : false;
  const editorDirty = editor?.dirty ?? false;
  const renderStale = editor?.renderStale ?? false;

  const value = useMemo<SessionState>(
    () => ({
      activeSong,
      activeSegment,
      activeBarIndex,
      lastReplay,
      editor,
      viewSong,
      canUndo,
      canRedo,
      editorDirty,
      renderStale,
      setActiveSong,
      setActiveTitle,
      setActiveLyrics,
      setActiveSegment,
      setActiveBarIndex,
      setLastReplay,
      applyEdit,
    }),
    [
      activeSong,
      activeSegment,
      activeBarIndex,
      lastReplay,
      editor,
      viewSong,
      canUndo,
      canRedo,
      editorDirty,
      renderStale,
      setActiveSong,
      setActiveTitle,
      setActiveLyrics,
      setActiveSegment,
      setActiveBarIndex,
      setLastReplay,
      applyEdit,
    ],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>');
  return ctx;
}
