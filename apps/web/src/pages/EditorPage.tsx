import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import { AppHeader } from '../layout/AppHeader';
import { EditorHeader } from '../layout/EditorHeader';
import { StatusBar } from '../layout/StatusBar';
import { MusicVideoView } from '../editor/MusicVideoView';
import { AssistantPanel } from '../editor/AssistantPanel';
import { TimelineView } from '../editor/TimelineView';
import { songsApi, songsQueryKeys } from '../api/songs';
import { useSession } from '../state/session';

export type EditorTab = 'timeline' | 'video';

/**
 * Editor screen, laid out like a DAW window:
 *   - top:    <AppHeader>     the app's navigation, as on every page (compact)
 *             <EditorHeader>  control bar (song · transport · views · export)
 *   - main:   the view (tracks with the mixer, or the music video)
 *   - bottom: <StatusBar>     playback status and downloads
 *
 * The view is route-driven so the URL is the source of truth (1/2
 * keyboard shortcuts also work).
 */
export function EditorPage({ tab }: { tab: EditorTab }) {
  const { songId } = useParams<{ songId: string }>();
  const navigate = useNavigate();
  const { activeSong, setActiveSong, applyEdit, canUndo, canRedo } = useSession();

  const deepLink = useQuery({
    queryKey: songsQueryKeys.song(songId ?? ''),
    queryFn: ({ signal }) => songsApi.get(songId as string, signal),
    enabled: Boolean(songId) && activeSong?.id !== songId,
    retry: 0,
  });

  useEffect(() => {
    if (deepLink.data && deepLink.data.id !== activeSong?.id) {
      setActiveSong(deepLink.data);
    }
  }, [deepLink.data, activeSong?.id, setActiveSong]);

  // Keyboard tab switching — rory-fe Editor.vue `Digit1/2` (Song, Music Video) — plus
  // standard undo/redo for the edit session.
  useEffect(() => {
    if (!songId) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /^(input|textarea|select)$/i.test(t.tagName)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.shiftKey && (e.code === 'KeyZ' || e.key === 'z')) {
        e.preventDefault();
        if (canUndo) applyEdit({ kind: 'undo' });
        return;
      }
      if (
        (mod && e.shiftKey && (e.code === 'KeyZ' || e.key === 'Z')) ||
        (mod && (e.code === 'KeyY' || e.key === 'y'))
      ) {
        e.preventDefault();
        if (canRedo) applyEdit({ kind: 'redo' });
        return;
      }
      if (e.code === 'Digit1') navigate(`/editor/${songId}/timeline`);
      if (e.code === 'Digit2') navigate(`/editor/${songId}/video`);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [navigate, songId, applyEdit, canUndo, canRedo]);

  return (
    <div className="relative flex h-screen w-screen flex-col overflow-hidden bg-[#1b1c1f]">
      <AppHeader compact />
      <EditorHeader tab={tab} />

      <div className="flex-1 min-h-0 relative flex">
        {!activeSong ? (
          <LoadingState error={deepLink.error} loading={deepLink.isLoading} />
        ) : (
          <div className="relative min-w-0 flex-1">
            <TabBody tab={tab} />
          </div>
        )}
      </div>

      <StatusBar />
    </div>
  );
}

function TabBody({ tab }: { tab: EditorTab }) {
  if (tab === 'video') return <MusicVideoView />;
  // The Song tab: the tracks, with the song assistant alongside (collapsible).
  return (
    <div className="flex h-full min-h-0">
      <div className="min-w-0 flex-1">
        <TimelineView />
      </div>
      <AssistantPanel />
    </div>
  );
}

function LoadingState({
  error,
  loading,
}: {
  error: Error | null;
  loading: boolean;
}) {
  return (
    <div className="flex-1 h-full flex flex-col items-center justify-center text-center px-8 gap-3">
      {loading ? (
        <>
          <div
            className="h-3 w-3 rounded-full bg-accent animate-pulse"
            aria-hidden="true"
          />
          <p className="text-muted text-[14px]">Loading song from brain…</p>
        </>
      ) : error ? (
        <>
          <p className="text-err text-[14px] font-mono">{error.message}</p>
          <p className="text-dim text-[12px]">
            This song is not in your projects (it may have been deleted, or
            saved under a new id). Go back to Projects and open it from there.
          </p>
        </>
      ) : (
        <p className="text-muted text-[14px]">No song selected.</p>
      )}
    </div>
  );
}
