import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { Song } from '@casperaki/song-schema';
import { useCallback, useMemo } from 'react';

import { playbackApi, type PlaybackPayload } from '../api/playback';
import { BrainError } from '../api/client';
import { vocalsApi } from '../api/vocals';
import { useSession } from '../state/session';
import { livePlayer } from './livePlayer';
import { currentProMix } from './proMix';
import { fnv1a } from './fnv1a';
import { hasVocalSettings, LEAD_VOCAL, singingTracks, singQueue, singRun, takesToken } from './singVocals';
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
  const vocalsPart = !hasVocalSettings(viewSong) ? '' : vocalStatus.data ? `:v${fnv1a(takesToken(vocalStatus.data.tracks))}` : undefined;
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
    await livePlayer.play(liveKey, fetchPayload);
    // Vocals on: the song plays at once with the sections sung so far; the unsung ones are sung meanwhile, from the
    // one being played on, and each joins the playing song as soon as it is ready.
    if (singingTracks(viewSong).length && baseKey) void singWhilePlaying(viewSong, baseKey, fetchPayload, queryClient);
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

/**
 * Sings the song's unsung sections one by one (from the section at the play position on); after each, the greyed
 * track updates and, if this song is playing, the player switches seamlessly to the version with the new take.
 * A new run (Play again) cancels this one; a failure is shown in the Vocals panel.
 */
async function singWhilePlaying(song: Song, baseKey: string, fetchPayload: (signal: AbortSignal) => Promise<PlaybackPayload>, queryClient: QueryClient): Promise<void> {
  const run = singRun.start();
  try {
    const status = await vocalsApi.status(song, run.signal);
    const queue = singQueue(song, status.tracks, livePlayer.position());
    for (const [i, { track, segment }] of queue.entries()) {
      vocalsProgress.set({ text: `Singing ${segment}${track === LEAD_VOCAL ? '' : ` (${track})`} (${i + 1} of ${queue.length})` });
      await vocalsApi.sing(song, segment, track, run.signal);
      const now = await vocalsApi.status(song, run.signal);
      const live = livePlayer.getState();
      if (live.status === 'playing' && live.key?.startsWith(baseKey)) {
        await livePlayer.play(`${baseKey}:v${fnv1a(takesToken(now.tracks))}`, fetchPayload, { seamless: true });
      }
      queryClient.setQueryData(vocalsStatusKey(song), now);
    }
    vocalsProgress.set({});
  } catch (err) {
    if (run.signal.aborted) return;
    vocalsProgress.set({ error: err instanceof BrainError ? (err.body?.message ?? err.message) : err instanceof Error ? err.message : String(err) });
  } finally {
    singRun.done(run);
  }
}

export { fnv1a } from './fnv1a';
