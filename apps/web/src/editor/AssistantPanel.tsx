import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { ChatThread, type ChatToolCall } from '@teamsuzie/ui';

import { songsApi } from '../api/songs';
import { livePlayer } from '../audio/livePlayer';
import { useLiveTransport } from '../audio/useLiveTransport';
import { useSession } from '../state/session';
import { useSaveSong } from '../state/useSongActions';
import type { Song } from '@casperaki/song-schema/schemas';
import { buildSequencerModel } from './sequencerModel';

const OPEN_STORAGE = 'casperaki.assistant.open';

/** Things only the page can do, asked for by the assistant's tools. */
type ClientAction =
  | { kind: 'play'; fromSection?: string }
  | { kind: 'stop' }
  | { kind: 'loop'; section: string }
  | { kind: 'mute' | 'unmute' | 'solo' | 'unsolo'; track: string }
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'save' }
  | { kind: 'renameSong'; title: string }
  | { kind: 'export' }
  | { kind: 'openTab'; tab: 'sound' | 'timeline' | 'video' };

interface ToolResult {
  summary?: string;
  song?: Song;
  action?: ClientAction;
}

function readOpen(): boolean {
  try {
    return window.localStorage.getItem(OPEN_STORAGE) === '1';
  } catch {
    return false;
  }
}
function writeOpen(on: boolean): void {
  try {
    window.localStorage.setItem(OPEN_STORAGE, on ? '1' : '0');
  } catch {
    // Not remembered in this browser; the panel still opens and closes now.
  }
}

/**
 * The song assistant, on the Song tab: a chat that edits the open song with
 * the same moves as the page (sounds, patterns, tracks, sections, transitions,
 * drums) and drives playback, save and export. Every change it makes is one
 * undoable edit, applied here as the brain's tools return it.
 */
export function AssistantPanel() {
  const [open, setOpenState] = useState(readOpen);
  const setOpen = (on: boolean) => {
    setOpenState(on);
    writeOpen(on);
  };
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-9 shrink-0 flex-col items-center justify-center gap-2 border-l border-black/70 bg-[#202124] text-[12px] text-white/70 hover:bg-[#2a2b30] hover:text-white"
        title="Open the song assistant"
        aria-label="Open the song assistant"
      >
        <span aria-hidden="true">✦</span>
        <span className="[writing-mode:vertical-rl]">Assistant</span>
      </button>
    );
  }
  return <OpenPanel onClose={() => setOpen(false)} />;
}

function OpenPanel({ onClose }: { onClose(): void }) {
  const { songId } = useParams<{ songId: string }>();
  if (!songId) throw new Error('AssistantPanel: no song id in the route');
  const navigate = useNavigate();
  const { viewSong, applyEdit, setActiveTitle } = useSession();
  const transport = useLiveTransport();
  const save = useSaveSong();
  const rename = useMutation({
    mutationFn: (title: string) => songsApi.rename(songId, title),
    onSuccess: ({ project }) => setActiveTitle(project.title),
  });
  const render = useMutation({ mutationFn: () => songsApi.render(songId) });
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const [chatKey, setChatKey] = useState(0); // "New chat" remounts the thread

  const model = useMemo(() => (viewSong ? buildSequencerModel(viewSong) : undefined), [viewSong]);
  const sectionSpan = useCallback(
    (name: string) => {
      if (!model || !viewSong) throw new Error('No song is open.');
      const sec = model.sections.find((s) => s.name === name);
      if (!sec) throw new Error(`The song has no section "${name}".`);
      const secPerBar = (4 * 60) / viewSong.bpm;
      return { start: sec.startBar * secPerBar, end: (sec.startBar + sec.bars) * secPerBar };
    },
    [model, viewSong],
  );

  const perform = useCallback(
    async (a: ClientAction) => {
      switch (a.kind) {
        case 'play':
          if (a.fromSection) transport.seek(sectionSpan(a.fromSection).start);
          if (!transport.playing) transport.playPause();
          return;
        case 'stop':
          transport.stop(false);
          return;
        case 'loop': {
          const span = sectionSpan(a.section);
          if (!transport.liveKey) throw new Error('No song is open.');
          await livePlayer.play(transport.liveKey, transport.fetchPayload);
          livePlayer.setLoopRange(span);
          livePlayer.setLooping(true);
          livePlayer.seek(span.start);
          return;
        }
        case 'mute':
        case 'unmute':
          livePlayer.setMuted(a.track, a.kind === 'mute');
          return;
        case 'solo':
        case 'unsolo':
          livePlayer.setSolo(a.track, a.kind === 'solo');
          return;
        case 'undo':
        case 'redo':
          applyEdit({ kind: a.kind });
          return;
        case 'save':
          await save.mutateAsync();
          return;
        case 'renameSong':
          await rename.mutateAsync(a.title);
          return;
        case 'export':
          await render.mutateAsync();
          return;
        case 'openTab':
          navigate(`/editor/${songId}/${a.tab}`);
          return;
      }
    },
    [transport, sectionSpan, applyEdit, save, rename, render, navigate, songId],
  );

  const onToolResult = useCallback(
    (call: ChatToolCall) => {
      if (call.status !== 'ok') return;
      const r = call.result as ToolResult | undefined;
      if (!r) return;
      // A changed song arrives whole; it lands as one undoable edit.
      if (r.song) applyEdit({ kind: 'replaceSong', song: r.song });
      if (r.action) {
        setActionError(undefined);
        perform(r.action).catch((err: unknown) => setActionError(err instanceof Error ? err.message : String(err)));
      }
    },
    [applyEdit, perform],
  );

  useEffect(() => setActionError(undefined), [chatKey]);

  return (
    <aside className="flex w-[380px] shrink-0 flex-col border-l border-black/70 bg-[#1e1f23] text-white" aria-label="Song assistant">
      <div className="flex items-center gap-2 border-b border-black/60 px-3 py-2">
        <span className="text-[14px] font-semibold">Assistant</span>
        <span className="text-[12px] text-white/45">edits this song</span>
        <button type="button" onClick={() => setChatKey((k) => k + 1)} className="ml-auto h-7 rounded-full px-2 text-[12px] text-white/60 hover:text-white" title="Start a new conversation">
          New chat
        </button>
        <button type="button" onClick={onClose} className="h-7 w-7 rounded-full text-white/60 hover:bg-white/10 hover:text-white" aria-label="Close the assistant">
          ✕
        </button>
      </div>
      {actionError ? (
        <p className="border-b border-black/60 bg-err/10 px-3 py-2 text-[12px] text-red-200" role="alert">
          {actionError}
        </p>
      ) : null}
      <div className="min-h-0 flex-1">
        <ChatThread
          key={chatKey}
          endpoint="/api/assistant/chat"
          chatId={null}
          extraBody={{ songId, song: viewSong, title: viewSong?.title }}
          onToolResult={onToolResult}
          placeholder="Ask for a change: “add a bridge after chorus 1”, “swap the keys for a warmer piano”, “loop the chorus”…"
          className="h-full"
        />
      </div>
    </aside>
  );
}
