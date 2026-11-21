import { useCallback, useMemo } from 'react';

import { playbackApi } from '../api/playback';
import { useSession } from '../state/session';
import { livePlayer } from './livePlayer';
import { useLivePosition, useLiveState } from './useLivePlayer';

/**
 * The editor's transport over the live player, shared by the play bar and
 * the sequencer: what Play plays (the saved song, or the working copy when
 * it has unsaved edits), whether that is what's loaded, the position, and
 * play / pause / seek.
 */
export function useLiveTransport() {
  const { activeSong, viewSong, editorDirty } = useSession();
  const songId = activeSong?.id;
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
      return editorDirty || !songId ? playbackApi.forSong(viewSong, signal) : playbackApi.forSaved(songId, signal);
    },
    [viewSong, editorDirty, songId],
  );

  const startPlaying = useCallback(async () => {
    if (!liveKey || !viewSong) return;
    await livePlayer.play(liveKey, fetchPayload);
  }, [liveKey, viewSong, fetchPayload]);

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

  return { liveKey, live, isThisSong, playing, loading, currentSeconds, fetchPayload, playPause, seek, editorDirty };
}

/** 32-bit FNV-1a of a string, as hex: a cheap key for the working copy. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}
