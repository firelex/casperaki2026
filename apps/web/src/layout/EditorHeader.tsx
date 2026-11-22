import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { renderInFlight, renderLabel, songsApi, songsQueryKeys, type ReplayResult } from '../api/songs';
import { useSession } from '../state/session';
import { useRenderStatus, useSaveSong, useStartRender } from '../state/useSongActions';
import type { EditorTab } from '../pages/EditorPage';
import { Transport } from './Transport';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@teamsuzie/ui';
import { useLiveTransport } from '../audio/useLiveTransport';
import { downloadBytes, fileStem, songMidi } from '../export/exportMidi';

/**
 * The editor's control bar, laid out like a DAW's: logo (back to the songs),
 * song name and save state, undo/redo on the left; the transport in the
 * centre; the views, Save and Export on the right. The ⟳ button replays the
 * generator to verify determinism.
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

  const pill =
    'h-8 rounded-[5px] border border-black/60 bg-gradient-to-b from-[#3b3d43] to-[#2b2c31] px-3 text-[12px] font-semibold text-[#e2e3e7] shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] hover:from-[#45474e] disabled:opacity-45';

  return (
    <header className="relative z-40 flex h-[56px] w-full shrink-0 items-center gap-4 border-b border-black/80 bg-gradient-to-b from-[#36383e] to-[#2a2b30] px-4 text-[#e2e3e7]">
      {/* Left: logo, song, undo/redo. */}
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <Link to="/" className="shrink-0" title="Back to your songs">
          <img src="/brand/casperaki-logo.svg" alt="Casperaki" width={124} height={15} className="block h-[15px] w-auto" />
        </Link>
        <span className="h-6 w-px shrink-0 bg-black/50" aria-hidden="true" />
        <div className="flex min-w-0 flex-col leading-tight">
          {activeSong ? <EditableTitle songId={activeSong.id} title={activeSong.project.title} /> : <span className="text-[13px] font-semibold text-white">Untitled</span>}
          <span className="text-[10px] text-[#9a9ba3]">
            {editorDirty ? <span className="text-accent">● Unsaved edits</span> : 'Saved'}
            {lastReplay ? (
              <span className={lastReplay.ok ? 'text-ok' : 'text-err'} title={lastReplay.hash}>
                {' '}· replay {lastReplay.ok ? 'ok' : 'mismatch'}
              </span>
            ) : null}
          </span>
        </div>
        <div className="ml-2 flex shrink-0 items-center">
          <IconBtn label={canUndo ? 'Undo (Ctrl+Z)' : 'Nothing to undo'} onClick={() => applyEdit({ kind: 'undo' })} disabled={!canUndo}>
            ↶
          </IconBtn>
          <IconBtn label={canRedo ? 'Redo (Ctrl+Shift+Z)' : 'Nothing to redo'} onClick={() => applyEdit({ kind: 'redo' })} disabled={!canRedo}>
            ↷
          </IconBtn>
        </div>
      </div>

      {/* Centre: the transport. */}
      <Transport />

      {/* Right: views, save, export. */}
      <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
        <nav className="flex rounded-[6px] border border-black/60 bg-[#1f2023] p-0.5" aria-label="Editor views">
          <TabLink active={tab === 'sound'} onClick={() => setTab('sound')}>Sounds</TabLink>
          <TabLink active={tab === 'timeline'} onClick={() => setTab('timeline')}>Tracks</TabLink>
          <TabLink active={tab === 'structure'} onClick={() => setTab('structure')}>Structure</TabLink>
        </nav>
        <IconBtn label={replay.isPending ? 'Verifying…' : 'Verify determinism (replay)'} onClick={() => replay.mutate()} disabled={!activeSong || replay.isPending}>
          ⟳
        </IconBtn>
        {actionError ? (
          <span className="max-w-[180px] truncate text-[11px] text-err" title={actionError.message}>
            {actionError.message}
          </span>
        ) : null}
        {editorDirty ? (
          <>
            <button type="button" onClick={() => applyEdit({ kind: 'revertToOriginal' })} className={pill} title="Discard edits and restore the generated song">
              Revert
            </button>
            <button type="button" onClick={() => save.mutate()} disabled={save.isPending} className={pill} title="Save the edited song to your projects">
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
          </>
        ) : null}
        <ExportMenu
          audioLabel={
            rendering
              ? `Exporting: ${renderLabel(renderStatus.data)}`
              : rendered && !editorDirty
                ? 'Audio ready (status bar)'
                : renderStatus.data?.state === 'failed'
                  ? 'Audio: retry WAV + MP3'
                  : editorDirty
                    ? 'Audio: save, then WAV + MP3'
                    : 'Audio: WAV + MP3'
          }
          audioDisabled={!activeSong || rendering || save.isPending || (rendered && !editorDirty)}
          busy={rendering}
          onAudio={() => void onRender()}
        />
      </div>
    </header>
  );
}

/** The song's title: click to rename (Enter saves, Escape cancels). */
function EditableTitle({ songId, title }: { songId: string; title: string }) {
  const { setActiveTitle } = useSession();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const rename = useMutation({
    mutationFn: (t: string) => songsApi.rename(songId, t),
    onSuccess: ({ project }) => {
      setActiveTitle(project.title);
      void queryClient.invalidateQueries({ queryKey: songsQueryKeys.list });
      setDraft(undefined);
    },
  });
  const commit = () => {
    if (draft === undefined) return;
    const t = draft.trim();
    if (!t || t === title) {
      setDraft(undefined);
      return;
    }
    rename.mutate(t);
  };
  if (draft !== undefined) {
    return (
      <span className="flex items-center gap-2">
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') setDraft(undefined);
          }}
          maxLength={120}
          disabled={rename.isPending}
          aria-label="Song title"
          className="h-6 w-[240px] rounded-[4px] border border-white/40 bg-black/40 px-1.5 text-[13px] font-semibold text-white outline-none focus:border-white"
        />
        {rename.isError ? <span className="text-[11px] text-err" title={rename.error.message}>Not renamed</span> : null}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => setDraft(title)}
      className="max-w-[260px] truncate rounded-[4px] px-1 -mx-1 text-left text-[13px] font-semibold text-white hover:bg-white/10"
      title="Rename the song"
    >
      {title}
    </button>
  );
}

/** Export: audio (server render) and MIDI (the version on screen, as the engine plays it). */
function ExportMenu({ audioLabel, audioDisabled, busy, onAudio }: { audioLabel: string; audioDisabled: boolean; busy: boolean; onAudio(): void }) {
  const { activeSong, viewSong } = useSession();
  const { liveKey, fetchPayload } = useLiveTransport();
  const [midi, setMidi] = useState<'idle' | 'making' | { error: string }>('idle');
  const exportMidi = async () => {
    if (!viewSong || !liveKey || !activeSong) return;
    setMidi('making');
    try {
      const bytes = await songMidi(viewSong, activeSong.project.title, liveKey, fetchPayload);
      downloadBytes(bytes, `${fileStem(activeSong.project.title)}.mid`, 'audio/midi');
      setMidi('idle');
    } catch (err) {
      setMidi({ error: err instanceof Error ? err.message : String(err) });
    }
  };
  const item = 'cursor-pointer rounded-[6px] px-3 py-2 text-[13px] outline-none data-[highlighted]:bg-white/10 data-[disabled]:opacity-40';
  return (
    <span className="flex items-center gap-2">
      {typeof midi === 'object' ? (
        <span className="max-w-[220px] truncate text-[11px] text-err" title={midi.error}>
          MIDI export failed: {midi.error}
        </span>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger className="h-8 rounded-[5px] border border-black/60 bg-gradient-to-b from-[#e0322b] to-[#b5221d] px-3.5 text-[12px] font-semibold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.15)] outline-none hover:from-[#ec3d35]">
          {busy ? 'Exporting…' : midi === 'making' ? 'Making MIDI…' : 'Export ▾'}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={6} className="z-50 min-w-[260px] rounded-[10px] border border-line bg-panel p-1 text-white shadow-2xl">
          <DropdownMenuItem className={item} disabled={audioDisabled} onSelect={onAudio}>
            {audioLabel}
          </DropdownMenuItem>
          <DropdownMenuItem className={item} disabled={!viewSong || !liveKey || midi === 'making'} onSelect={() => void exportMidi()}>
            MIDI file (.mid) <span className="ml-auto pl-4 text-[11px] text-white/45">as played, unsaved edits included</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}

function TabLink({ active, children, onClick }: { active: boolean; children: React.ReactNode; onClick(): void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={`h-7 rounded-[4px] px-3 text-[12px] font-semibold ${active ? 'bg-[#4a4c53] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.1)]' : 'text-[#a9aab1] hover:text-white'}`}
    >
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
      className={`mx-0.5 flex h-8 w-8 items-center justify-center rounded-[5px] text-[16px] ${
        disabled ? 'cursor-not-allowed text-white/25' : 'text-[#d9dade] hover:bg-white/10 hover:text-white'
      }`}
    >
      {children}
    </button>
  );
}

function tab2Path(t: EditorTab): string {
  return t === 'sound' ? 'sound' : t === 'timeline' ? 'timeline' : 'structure';
}
