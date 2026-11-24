import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';

import { songsApi, songsQueryKeys, type GeneratedSong, type ProjectLyrics } from '../api/songs';
import type { Song } from '@casperaki/song-schema';
import { tracksApi } from '../api/tracks';
import { useSession } from './session';

/** What the brain sends on /api/events (apps/brain/src/events.ts). */
export type LyricsEvent =
  | { readonly type: 'lyrics'; readonly state: 'done'; readonly songId: string; readonly newSongId: string; readonly lyrics: Readonly<Record<string, readonly string[]>> }
  | { readonly type: 'lyrics'; readonly state: 'failed'; readonly songId: string; readonly message: string };

/**
 * Listens for the brain's events while signed in. A new song's lyrics are written in the background and saved by the
 * brain as a new version of the project; when the open song is that project:
 * - no unsaved edits: the editor switches to the new version;
 * - unsaved edits: the words are put into the working song (the brain splices them into the vocal tracks) on top of
 *   the new version, so the edits stay and the next save goes to the right place;
 * - writing failed: the Vocal track shows why.
 * The project list refreshes either way.
 */
export function useLyricsEvents(): void {
  const session = useSession();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  // The handler reads the latest state, not the state when the stream opened.
  const latest = useRef({ session, location });
  latest.current = { session, location };

  useEffect(() => {
    const stream = new EventSource('/api/events', { withCredentials: true });
    const onLyrics = (event: LyricsEvent) =>
      handleLyricsEvent(event, {
        ...latest.current.session,
        pathname: latest.current.location.pathname,
        navigate: (path) => navigate(path, { replace: true }),
        getSong: (id) => songsApi.get(id),
        applyLyrics: async (song, lyrics) => (await tracksApi.edit(song, { kind: 'applyLyrics', lyrics })).song,
        refreshList: () => void queryClient.invalidateQueries({ queryKey: songsQueryKeys.list }),
        cacheSong: (saved, oldId) => {
          queryClient.setQueryData(songsQueryKeys.song(saved.id), saved);
          queryClient.removeQueries({ queryKey: songsQueryKeys.song(oldId) });
        },
      });
    stream.addEventListener('lyrics', (m) => void onLyrics(JSON.parse((m as MessageEvent<string>).data) as LyricsEvent));
    // A song's artwork was drawn (or failed): the project list shows it.
    stream.addEventListener('artwork', () => void queryClient.invalidateQueries({ queryKey: songsQueryKeys.list }));
    return () => stream.close();
  }, [queryClient, navigate]);
}

/** What handling a lyrics event needs: the session's parts, the brain and the router. */
export interface LyricsEventContext {
  readonly activeSong: GeneratedSong | undefined;
  readonly editorDirty: boolean;
  readonly viewSong: Song | undefined;
  readonly pathname: string;
  setActiveSong(song: GeneratedSong): void;
  setActiveLyrics(lyrics: ProjectLyrics | null): void;
  applyEdit(command: { kind: 'replaceSong'; song: Song }): void;
  navigate(path: string): void;
  getSong(id: string): Promise<GeneratedSong>;
  applyLyrics(song: Song, lyrics: Readonly<Record<string, readonly string[]>>): Promise<Song>;
  refreshList(): void;
  cacheSong(saved: GeneratedSong, oldId: string): void;
}

export async function handleLyricsEvent(event: LyricsEvent, c: LyricsEventContext): Promise<void> {
  c.refreshList();
  if (c.activeSong?.id !== event.songId) return;
  if (event.state === 'failed') {
    c.setActiveLyrics({ state: 'failed', message: event.message });
    return;
  }
  try {
    const saved = await c.getSong(event.newSongId);
    const merged = c.editorDirty && c.viewSong ? await c.applyLyrics(c.viewSong, event.lyrics) : undefined;
    c.setActiveSong(saved);
    if (merged) c.applyEdit({ kind: 'replaceSong', song: merged });
    c.cacheSong(saved, event.songId);
    if (c.pathname.includes(`/editor/${event.songId}`)) c.navigate(c.pathname.replace(`/editor/${event.songId}`, `/editor/${saved.id}`));
  } catch (err) {
    c.setActiveLyrics({ state: 'failed', message: `The lyrics are saved, but the editor could not load them: ${err instanceof Error ? err.message : String(err)}. Reload the song.` });
  }
}
