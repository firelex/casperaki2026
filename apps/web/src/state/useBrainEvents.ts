import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { songsQueryKeys } from '../api/songs';

/** Listens for the brain's events (/api/events, apps/brain/src/events.ts) while signed in: a song's artwork was drawn
 *  (or drawing it failed), so the project list refreshes. */
export function useBrainEvents(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    const stream = new EventSource('/api/events', { withCredentials: true });
    stream.addEventListener('artwork', () => void queryClient.invalidateQueries({ queryKey: songsQueryKeys.list }));
    return () => stream.close();
  }, [queryClient]);
}
