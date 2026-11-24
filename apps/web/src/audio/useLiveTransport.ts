import { useCallback, useMemo, useRef } from 'react';

import { playbackApi } from '../api/playback';
import { BrainError } from '../api/client';
import { vocalsApi } from '../api/vocals';
import { useSession } from '../state/session';
import { livePlayer } from './livePlayer';
import { currentProMix } from './proMix';
import { singBeforePlay, singRun } from './singVocals';
import { vocalsProgress } from './vocalsProgress';
import { useLivePosition, useLiveState } from './useLivePlayer';

/**
 * The editor's transport over the live player, shared by the play bar and
 * the sequencer: what Play plays (the saved song, or the working copy when
 * it has unsaved edits), whether that is what's loaded, the position, and
 * play / pause / seek.
 */
export function useLiveTransport() {
  const { activeSong, viewSong, editorDirty, applyEdit } = useSession();
  const songId = activeSong?.id;
  /** The song on screen now (singing checks it is still the one it started from before applying takes). */
  const latestSong = useRef(viewSong);
  latestSong.current = viewSong;
  const liveKey = useMemo(
    () => (viewSong && editorDirty ? `edit:${fnv1a(JSON.stringify(viewSong))}` : songId),
    [viewSong, editorDirty, songId],
  );
  const live = useLiveState();
  const isThisSong = live.key !== undefined && live.key === liveKey;
  const playing = isThisSong && live.status === 'playing';
  const loading = isThisSong && live.status === 'loading';
  const position = useLivePosition(playing);
  const currentSeconds = isThisSong ? position : 0;

  const fetchPayload = useCallback(
    (signal: AbortSignal) => {
      if (!viewSong) throw new Error('No song is open.');
      return editorDirty || !songId ? playbackApi.forSong(viewSong, signal, currentProMix()) : playbackApi.forSaved(songId, signal);
    },
    [viewSong, editorDirty, songId],
  );

  const startPlaying = useCallback(async () => {
    if (!liveKey || !viewSong) return;
    // Sung vocals on: first sing the sections whose take is missing or stale (seconds each), then play the sung
    // song. One run at a time: Play while singing cancels it. If the song on screen changed meanwhile (edited, or
    // another song opened), the takes are not applied to it (they stay stored: Play again reuses them).
    // A failure is shown and nothing plays (no silent vocal-less playback).
    if (viewSong.vocals?.enabled) {
      const run = singRun.toggle();
      if (!run) {
        vocalsProgress.set({});
        return;
      }
      const started = viewSong;
      let outcome;
      try {
        vocalsProgress.set({ text: 'Checking the vocals…' });
        outcome = await singBeforePlay(started, vocalsApi, (s) => latestSong.current === s, (text) => vocalsProgress.set({ text }), run.signal);
      } catch (err) {
        vocalsProgress.set({ error: err instanceof BrainError ? (err.body?.message ?? err.message) : err instanceof Error ? err.message : String(err) });
        return;
      } finally {
        singRun.done(run);
      }
      if (outcome.kind === 'cancelled') return vocalsProgress.set({});
      if (outcome.kind === 'changed') return vocalsProgress.set({ text: 'The song changed while singing; press Play again (sung sections are kept).' });
      vocalsProgress.set({});
      const sung = outcome.song;
      if (sung !== started) {
        applyEdit({ kind: 'replaceSong', song: sung });
        await livePlayer.play(`edit:${fnv1a(JSON.stringify(sung))}`, (signal) => playbackApi.forSong(sung, signal, currentProMix()));
        return;
      }
    }
    await livePlayer.play(liveKey, fetchPayload);
  }, [liveKey, viewSong, fetchPayload, applyEdit]);

  const playPause = useCallback(() => {
    if (playing) void livePlayer.pause();
    else void startPlaying();
  }, [playing, startPlaying]);

  /** Jump to `seconds`; if this version isn't loaded yet, start it first. */
  const seek = useCallback(
    (seconds: number) => {
      if (!liveKey || !Number.isFinite(seconds)) return;
      if (livePlayer.isLoaded(liveKey)) {
        livePlayer.seek(seconds);
        return;
      }
      void startPlaying().then(() => {
        if (livePlayer.isLoaded(liveKey)) livePlayer.seek(seconds);
      });
    },
    [liveKey, startPlaying],
  );

  /** Stop: back to where Play started; `toStart` (double-click) to the beginning. */
  const stop = useCallback(
    (toStart: boolean) => {
      if (liveKey && livePlayer.isLoaded(liveKey)) void livePlayer.stopAndReturn(toStart);
    },
    [liveKey],
  );

  const toggleLoop = useCallback(() => {
    livePlayer.setLooping(!live.looping);
  }, [live.looping]);

  return {
    liveKey, live, isThisSong, playing, loading, currentSeconds, fetchPayload, playPause, seek, stop, toggleLoop, editorDirty,
  };
}

/** 32-bit FNV-1a of a string, as hex: a cheap key for the working copy. */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}
