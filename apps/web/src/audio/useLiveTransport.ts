import { useCallback } from 'react';

import { playbackApi } from '../api/playback';
import { useSession } from '../state/session';
import { livePlayer } from './livePlayer';
import { currentProMix } from './proMix';
import { fnv1a } from './fnv1a';
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
  const liveKey = viewSong && editorDirty ? `edit:${fnv1a(JSON.stringify(viewSong))}` : songId;
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

export { fnv1a } from './fnv1a';
