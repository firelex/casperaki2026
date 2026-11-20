import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';

import { renderInFlight, songsApi, songsQueryKeys, type GeneratedSong, type RenderInfo } from '../api/songs';
import { useSession } from './session';

/**
 * Save the editor's working copy to the brain.
 *
 * Songs are content-addressed, so a saved edit comes back under a new id.
 * On success the saved song becomes the active song (fresh edit session,
 * not dirty), the caches are primed, and the URL moves to the new id on
 * the same editor tab.
 */
export function useSaveSong() {
  const { activeSong, viewSong, setActiveSong } = useSession();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();

  return useMutation<GeneratedSong, Error, void>({
    mutationFn: () => {
      if (!activeSong || !viewSong) throw new Error('No song is open in the editor.');
      return songsApi.save(activeSong.id, viewSong);
    },
    onSuccess: (saved) => {
      const oldId = activeSong?.id;
      setActiveSong(saved);
      queryClient.setQueryData(songsQueryKeys.song(saved.id), saved);
      if (oldId && oldId !== saved.id) queryClient.removeQueries({ queryKey: songsQueryKeys.song(oldId) });
      void queryClient.invalidateQueries({ queryKey: songsQueryKeys.list });
      if (oldId && oldId !== saved.id) {
        navigate(location.pathname.replace(`/editor/${oldId}`, `/editor/${saved.id}`), { replace: true });
      }
    },
  });
}

/** Render status of a song, polling every 2 s while a render is in flight. */
export function useRenderStatus(songId: string | undefined) {
  return useQuery<RenderInfo>({
    queryKey: songsQueryKeys.render(songId ?? ''),
    queryFn: ({ signal }) => songsApi.renderStatus(songId as string, signal),
    enabled: Boolean(songId),
    refetchInterval: (q) => (renderInFlight(q.state.data) ? 2000 : false),
  });
}

/** Queue a server-side render of the song (saved state, not unsaved edits). */
export function useStartRender() {
  const queryClient = useQueryClient();
  return useMutation<RenderInfo, Error, string>({
    mutationFn: (songId) => songsApi.render(songId),
    onSuccess: (info, songId) => {
      queryClient.setQueryData(songsQueryKeys.render(songId), info);
      void queryClient.invalidateQueries({ queryKey: songsQueryKeys.list });
    },
  });
}
