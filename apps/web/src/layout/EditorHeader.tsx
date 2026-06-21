import { useMutation } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';

import { songsApi, type ReplayResult } from '../api/songs';
import { useSession } from '../state/session';
import type { EditorTab } from '../pages/EditorPage';

/**
 * Editor header — mirrors rory-fe `Editor.vue` header:
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │ ← ↶ ↷   Sound Design   Timeline   Structure        ⚙ Publish │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * Active tab carries a 4px red top-underline (rory's `nav a.active::before`).
 * Publish is currently a placeholder mutation — uses POST /replay so
 * the button has a real workflow (verifies determinism). When the
 * publish endpoint lands on the brain, it becomes a real publish.
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
          <span className="ml-3 font-mono text-[12px] text-white/80">
            #{activeSong.id}
          </span>
        ) : null}
        {editorDirty ? (
          <span
            className="ml-3 text-[10px] uppercase tracking-[0.18em] text-accent font-semibold"
            title="Unsaved local edits — no backend persistence yet"
          >
            ● edited
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
        <IconBtn label="Settings" disabled>
          ⚙
        </IconBtn>
        <button
          type="button"
          className="h-11 px-7 rounded-full bg-accent text-white text-[15px] font-semibold uppercase tracking-wide hover:bg-accent/90 transition-colors"
          disabled
          title="Publish endpoint not on the brain yet"
        >
          Publish
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
