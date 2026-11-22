import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { tracksApi, type TrackEdit } from '../../api/tracks';
import { useSession } from '../../state/session';

/**
 * Track edits in the sequencer. Sound changes, new patterns and new tracks
 * are written by the brain's generator (it returns the whole song); removing
 * a track is a local edit. All of them are undoable edits of the working song.
 */
export function useTrackEdits(songKey: string | undefined) {
  const { viewSong, applyEdit } = useSession();
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const options = useQuery({
    queryKey: ['track-options', songKey],
    queryFn: ({ signal }) => {
      if (!viewSong) throw new Error('No song is open.');
      return tracksApi.options(viewSong, signal);
    },
    enabled: Boolean(viewSong && songKey),
    staleTime: Infinity,
  });

  const run = useCallback(
    async (op: TrackEdit, label: string) => {
      if (!viewSong) throw new Error('No song is open.');
      setBusy(label);
      setError(undefined);
      try {
        const { song } = await tracksApi.edit(viewSong, op);
        applyEdit({ kind: 'replaceSong', song });
      } catch (err) {
        setError(`${label} failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setBusy(undefined);
      }
    },
    [viewSong, applyEdit],
  );

  /** Any brain-written change of the song (e.g. a generated section), as one undoable edit. */
  const runSongEdit = useCallback(
    async (label: string, make: (song: NonNullable<typeof viewSong>) => Promise<NonNullable<typeof viewSong>>) => {
      if (!viewSong) throw new Error('No song is open.');
      setBusy(label);
      setError(undefined);
      try {
        applyEdit({ kind: 'replaceSong', song: await make(viewSong) });
      } catch (err) {
        setError(`${label} failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setBusy(undefined);
      }
    },
    [viewSong, applyEdit],
  );

  const removeTrack = useCallback((track: string) => applyEdit({ kind: 'removeTrack', track }), [applyEdit]);

  return { options, run, runSongEdit, removeTrack, busy, error, clearError: () => setError(undefined) };
}
