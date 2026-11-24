import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

import { playbackApi } from '../api/playback';
import { BrainError } from '../api/client';
import { vocalsApi } from '../api/vocals';
import { useSession } from '../state/session';
import { livePlayer } from './livePlayer';
import { currentProMix } from './proMix';
import { fnv1a } from './fnv1a';
import { singBeforePlay, singRun, takesToken } from './singVocals';
import { useVocalsStatus, vocalsStatusKey } from './useVocalsStatus';
import { vocalsProgress } from './vocalsProgress';
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
  const queryClient = useQueryClient();
  // A song with a vocals setting plays the takes the brain has for it: which sections have one is part of the
  // key, so a section sung since the song was loaded makes a new version to play (undefined while not known).
  const vocalStatus = useVocalsStatus(viewSong);
  const vocalsPart = !viewSong?.vocals ? '' : vocalStatus.data ? `:v${fnv1a(takesToken(vocalStatus.data.sections))}` : undefined;
  const baseKey = viewSong && editorDirty ? `edit:${fnv1a(JSON.stringify(viewSong))}` : songId;
  const liveKey = useMemo(() => (baseKey && vocalsPart !== undefined ? baseKey + vocalsPart : undefined), [baseKey, vocalsPart]);
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
    // Vocals on: Play first sings the unsung sections (seconds each); the brain adds every stored take when the
    // song loads. One run at a time: Play while singing cancels it. A failure is shown and nothing plays.
    if (viewSong.vocals?.enabled) {
      const run = singRun.toggle();
      if (!run) {
        vocalsProgress.set({});
        return;
      }
      try {
        vocalsProgress.set({ text: 'Checking the vocals…' });
        const outcome = await singBeforePlay(viewSong, vocalsApi, (text) => vocalsProgress.set({ text }), run.signal);
        if (outcome === 'cancelled') return vocalsProgress.set({});
        const st = await queryClient.fetchQuery({ queryKey: vocalsStatusKey(viewSong), queryFn: () => vocalsApi.status(viewSong), staleTime: 0 });
        vocalsProgress.set({});
        if (!baseKey) return;
        await livePlayer.play(`${baseKey}:v${fnv1a(takesToken(st.sections))}`, fetchPayload);
        return;
      } catch (err) {
        vocalsProgress.set({ error: err instanceof BrainError ? (err.body?.message ?? err.message) : err instanceof Error ? err.message : String(err) });
        return;
      } finally {
        singRun.done(run);
      }
    }
    await livePlayer.play(liveKey, fetchPayload);
  }, [liveKey, viewSong, fetchPayload, baseKey, queryClient]);

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
