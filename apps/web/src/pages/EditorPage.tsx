import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import { EditorHeader } from '../layout/EditorHeader';
import { Playbar } from '../layout/Playbar';
import { SoundDesignView } from '../editor/SoundDesignView';
import { TimelineView } from '../editor/TimelineView';
import { StructureView } from '../editor/StructureView';
import { SegmentInspector } from '../editor/SegmentInspector';
import { songsApi, songsQueryKeys } from '../api/songs';
import { useSession } from '../state/session';

export type EditorTab = 'sound' | 'timeline' | 'structure';

/**
 * Editor screen — mirrors rory-fe `Editor.vue`.
 *
 * Three rows:
 *   - top:   <EditorHeader>     (back / undo / redo · tabs · publish)
 *   - main:  <TabView>          (sound design / timeline / structure)
 *   - bot:   <Playbar>          (mixer · transport · BPM)
 *
 * Tab is route-driven so the URL is the source of truth (1/2/3
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

  // Keyboard tab switching — rory-fe Editor.vue `Digit1/2/3` — plus
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
      if (e.code === 'Digit1') navigate(`/editor/${songId}/sound`);
      if (e.code === 'Digit2') navigate(`/editor/${songId}/timeline`);
      if (e.code === 'Digit3') navigate(`/editor/${songId}/structure`);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [navigate, songId, applyEdit, canUndo, canRedo]);

  return (
    <div className="flex flex-col h-screen w-screen bg-[#0d0d17] glow-bg relative overflow-hidden">
      <EditorHeader tab={tab} />

      <div className="flex-1 min-h-0 relative flex">
        {!activeSong ? (
          <LoadingState error={deepLink.error} loading={deepLink.isLoading} />
        ) : (
          <>
            <div className="flex-1 min-w-0 relative">
              <TabBody tab={tab} />
            </div>
            <SegmentInspector />
          </>
        )}
      </div>

      <Playbar />
    </div>
  );
}

function TabBody({ tab }: { tab: EditorTab }) {
  if (tab === 'sound') return <SoundDesignView />;
  if (tab === 'timeline') return <TimelineView />;
  return <StructureView />;
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
            The brain may not know this song id (the M0 session store is
            in-memory). Go back to Projects and generate a new one.
          </p>
        </>
      ) : (
        <p className="text-muted text-[14px]">No song selected.</p>
      )}
    </div>
  );
}
