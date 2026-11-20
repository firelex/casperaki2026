import { useMutation } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';

import { renderInFlight, renderLabel, songsApi, type ReplayResult } from '../api/songs';
import { useSession } from '../state/session';
import { useRenderStatus, useSaveSong, useStartRender } from '../state/useSongActions';
import type { EditorTab } from '../pages/EditorPage';

/**
 * Editor header — mirrors rory-fe `Editor.vue` header:
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │ ← ↶ ↷   Sound Design   Timeline   Structure        ⚙ Publish │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * Active tab carries a 4px red top-underline (rory's `nav a.active::before`).
 * Right side: Save (when there are unsaved edits) and Render, the
 * primary action. Render works on the saved song, so with unsaved edits
 * it saves first ("Save & render"). The ⟳ button replays the generator
 * to verify determinism.
 */
export function EditorHeader({ tab }: { tab: EditorTab }) {
  const navigate = useNavigate();
  const { songId } = useParams<{ songId: string }>();
  const {
    activeSong,
    setLastReplay,
    lastReplay,
    canUndo,
    canRedo,
    editorDirty,
    applyEdit,
  } = useSession();

  const save = useSaveSong();
  const renderStatus = useRenderStatus(activeSong?.id);
  const startRender = useStartRender();
  const rendering = renderInFlight(renderStatus.data) || startRender.isPending;
  const rendered = renderStatus.data?.state === 'done';
  const onRender = async () => {
    if (!activeSong) return;
    const id = editorDirty ? (await save.mutateAsync()).id : activeSong.id;
    startRender.mutate(id);
  };
  const actionError = save.error ?? startRender.error;

  const replay = useMutation<ReplayResult, Error>({
    mutationFn: () => songsApi.replay(activeSong!.id),
    onSuccess: (data) => setLastReplay(data),
  });

  const setTab = (t: EditorTab) => {
    if (songId) navigate(`/editor/${songId}/${tab2Path(t)}`);
  };

  return (
    <header className="flex items-stretch justify-between w-full h-[72px] border-b border-line/80 bg-[#0d0d17]">
      <div className="flex items-center pl-8 pr-4">
        <IconBtn label="Back" onClick={() => navigate('/')}>
          ←
        </IconBtn>
        <IconBtn
          label={canUndo ? 'Undo' : 'Nothing to undo'}
          onClick={() => applyEdit({ kind: 'undo' })}
          disabled={!canUndo}
        >
          ↶
        </IconBtn>
        <IconBtn
          label={canRedo ? 'Redo' : 'Nothing to redo'}
          onClick={() => applyEdit({ kind: 'redo' })}
          disabled={!canRedo}
        >
          ↷
        </IconBtn>
        <span className="ml-6 text-[11px] uppercase tracking-[0.18em] text-dim font-semibold">
          editor
        </span>
        {activeSong ? (
          <span
            className="ml-3 text-[14px] text-white/90 font-semibold truncate max-w-[22vw]"
            title={`#${activeSong.id}`}
          >
            {activeSong.project.title}
          </span>
        ) : null}
        {editorDirty ? (
          <span
            className="ml-3 text-[10px] uppercase tracking-[0.18em] text-accent font-semibold"
            title="Unsaved edits — press Save to keep them"
          >
            ● unsaved
          </span>
        ) : null}
      </div>

      <nav className="flex items-center">
        <TabLink active={tab === 'sound'} onClick={() => setTab('sound')}>
          Sound Design
        </TabLink>
        <TabLink active={tab === 'timeline'} onClick={() => setTab('timeline')}>
          Timeline
        </TabLink>
        <TabLink active={tab === 'structure'} onClick={() => setTab('structure')}>
          Structure
        </TabLink>
      </nav>

      <div className="flex items-center pl-4 pr-10 gap-3">
        {editorDirty ? (
          <button
            type="button"
            onClick={() => applyEdit({ kind: 'revertToOriginal' })}
            className="h-9 px-3 rounded-md text-[11px] uppercase tracking-wider font-semibold text-white/80 border border-line hover:border-accent hover:text-white"
            title="Discard edits and restore the brain-generated song"
          >
            Revert
          </button>
        ) : null}
        {lastReplay ? (
          <span
            className={`text-[11px] uppercase tracking-wide font-semibold ${
              lastReplay.ok ? 'text-ok' : 'text-err'
            }`}
            title={lastReplay.hash}
          >
            replay {lastReplay.ok ? 'ok' : 'mismatch'}
          </span>
        ) : null}
        <IconBtn
          label={replay.isPending ? 'Verifying…' : 'Verify determinism (replay)'}
          onClick={() => replay.mutate()}
          disabled={!activeSong || replay.isPending}
        >
          ⟳
        </IconBtn>
        {actionError ? (
          <span className="text-err text-[11px] max-w-[220px] truncate" title={actionError.message}>
            {actionError.message}
          </span>
        ) : null}
        {editorDirty ? (
          <button
            type="button"
            onClick={() => save.mutate()}
            disabled={save.isPending}
            className="h-11 px-5 rounded-full border border-line text-white text-[14px] font-semibold uppercase tracking-wide hover:border-accent disabled:opacity-50"
            title="Save the edited song to your projects"
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => void onRender()}
          disabled={!activeSong || rendering || save.isPending || (rendered && !editorDirty)}
          className="h-11 px-7 rounded-full bg-accent text-white text-[15px] font-semibold uppercase tracking-wide hover:bg-accent/90 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          title={
            rendered && !editorDirty
              ? 'This version is rendered — play it below'
              : 'Render this song to audio on the server'
          }
        >
          {rendering
            ? renderLabel(renderStatus.data)
            : editorDirty
              ? 'Save & render'
              : rendered
                ? 'Rendered'
                : renderStatus.data?.state === 'failed'
                  ? 'Retry render'
                  : 'Render'}
        </button>
      </div>
    </header>
  );
}

function TabLink({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative h-full px-7 text-[17px] font-medium transition-colors ${
        active ? 'text-white' : 'text-white/50 hover:text-white/80'
      }`}
    >
      <span
        className={`absolute top-0 left-0 right-0 h-[3px] bg-accent transition-transform ${
          active ? 'translate-y-0' : '-translate-y-[4px] opacity-0'
        }`}
        aria-hidden="true"
      />
      {children}
    </button>
  );
}

function IconBtn({
  label,
  children,
  onClick,
  disabled,
}: {
  label: string;
  children: React.ReactNode;
  onClick?(): void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={`h-10 w-10 mx-0.5 rounded-md flex items-center justify-center text-[18px] transition-colors ${
        disabled
          ? 'text-white/30 cursor-not-allowed'
          : 'text-white/75 hover:text-white hover:bg-white/10'
      }`}
    >
      {children}
    </button>
  );
}

function tab2Path(t: EditorTab): string {
  return t === 'sound' ? 'sound' : t === 'timeline' ? 'timeline' : 'structure';
}
