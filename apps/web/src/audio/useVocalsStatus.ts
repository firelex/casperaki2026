import { useQuery } from '@tanstack/react-query';
import type { Song } from '@casperaki/song-schema';

import { vocalsApi } from '../api/vocals';
import { fnv1a } from './fnv1a';
import { hasVocalSettings } from './singVocals';

/** The query key of a song's take status (shared by the transport, the timeline and the Vocals panel). */
export const vocalsStatusKey = (song: Song) => ['vocals', 'status', fnv1a(JSON.stringify(song))] as const;

/** Which sections of each sung vocal track have a take (only for songs with a singing setting: a voice). */
export function useVocalsStatus(song: Song | undefined) {
  return useQuery({
    queryKey: song ? vocalsStatusKey(song) : ['vocals', 'status', 'none'],
    queryFn: ({ signal }) => vocalsApi.status(song!, signal),
    enabled: hasVocalSettings(song),
    staleTime: 10_000,
  });
}
