import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChatThread, type ChatToolCall } from '@teamsuzie/ui';

import { songsApi, songsQueryKeys } from '../api/songs';
import { livePlayer, type MixConfigJson, type ResolvedMix } from '../audio/livePlayer';
import { changeBusParam, changeLane, changeLaneRoute, linkedLanes, resetProMix, useProMix } from '../audio/proMix';
import { useLiveTransport } from '../audio/useLiveTransport';
import { useSession } from '../state/session';
import { useSaveSong } from '../state/useSongActions';
import type { Song } from '@casperaki/song-schema/schemas';
import { mixSnapshot } from './mixSnapshot';
import { buildSequencerModel } from './sequencerModel';

const OPEN_STORAGE = 'casperaki.assistant.open';

/**
 * The theme tokens @teamsuzie/ui's ChatThread draws with (bubbles, borders,
 * tool rows), in this app's dark palette. Set on the panel only: the app's
 * own `--color-muted` is a text colour, the chat's is a surface.
 */
const CHAT_THEME = {
  '--color-background': '#1e1f23',
  '--color-foreground': '#e6e7ea',
  '--color-primary': '#6fa8e8',
  '--color-border': '#34363d',
  '--color-muted': '#2a2c32',
  '--color-muted-foreground': '#9a9ca5',
  '--color-card': '#26282d',
} as CSSProperties;

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
  | { kind: 'openTab'; tab: 'timeline' | 'video' }
  | { kind: 'goTo'; section?: string; bar?: number }
  | { kind: 'revert' }
  | { kind: 'newSong'; genre: string; key: string; bpm: number }
  | { kind: 'mixTrack'; track: string; levelDb?: number; reverb?: number; delay?: number; chorus?: number; bus?: string | null }
  | { kind: 'busSetting'; bus: string; slot: number; param: number; value: number }
  | { kind: 'resetMix' };

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
  const { viewSong, applyEdit, setActiveTitle, setActiveSong } = useSession();
  const queryClient = useQueryClient();
  // Pro mode: the assistant can read and change the mix (the mix tools are offered only then).
  const pro = useProMix();
  const [resolved, setResolved] = useState<{ mix: ResolvedMix; standard: MixConfigJson['rackChains'] } | undefined>(undefined);
  const [mixError, setMixError] = useState<string | undefined>(undefined);
  const transport = useLiveTransport();
  const save = useSaveSong();
  const rename = useMutation({
    mutationFn: (title: string) => songsApi.rename(songId, title),
    onSuccess: ({ project }) => setActiveTitle(project.title),
  });
  const render = useMutation({ mutationFn: () => songsApi.render(songId) });
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const [chatKey, setChatKey] = useState(0); // "New chat" remounts the thread

  useEffect(() => {
    setResolved(undefined);
    setMixError(undefined);
    if (!pro.pro || !transport.liveKey) return;
    let cancelled = false;
    Promise.all([livePlayer.mixOf(transport.liveKey, transport.fetchPayload), livePlayer.payloadOf(transport.liveKey, transport.fetchPayload)]).then(
      ([mix, payload]) => !cancelled && setResolved({ mix, standard: payload.standardRackChains }),
      (err: unknown) => !cancelled && setMixError(`The assistant cannot read the mix: ${err instanceof Error ? err.message : String(err)}`),
    );
    return () => {
      cancelled = true;
    };
    // pro.version: the mix was reset or rerouted (the engine resolved it again).
  }, [pro.pro, pro.version, transport.liveKey, transport.fetchPayload]);
  const snapshot = useMemo(() => (pro.pro && resolved ? mixSnapshot(resolved.mix, pro.mix, resolved.standard) : undefined), [pro.pro, pro.mix, resolved]);

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
        case 'goTo': {
          if (!viewSong) throw new Error('No song is open.');
          transport.seek(a.section !== undefined ? sectionSpan(a.section).start : (a.bar! - 1) * ((4 * 60) / viewSong.bpm));
          return;
        }
        case 'revert':
          applyEdit({ kind: 'revertToOriginal' });
          return;
        case 'newSong': {
          const data = await songsApi.generate({ genre: a.genre as Parameters<typeof songsApi.generate>[0]['genre'], key: a.key, bpm: a.bpm, seed: Math.floor(Math.random() * 1e9) });
          setActiveSong(data);
          void queryClient.invalidateQueries({ queryKey: songsQueryKeys.list });
          queryClient.setQueryData(songsQueryKeys.song(data.id), data);
          navigate(`/editor/${data.id}/timeline`);
          return;
        }
        case 'mixTrack': {
          if (!pro.pro || !resolved) throw new Error('Pro mode is off: press Pro to change the mix.');
          const lanes = linkedLanes(resolved.mix, a.track);
          const patch = {
            ...(a.levelDb !== undefined ? { volumeDb: a.levelDb } : {}),
            ...(a.reverb !== undefined ? { reverb: a.reverb } : {}),
            ...(a.delay !== undefined ? { delay: a.delay } : {}),
            ...(a.chorus !== undefined ? { chorus: a.chorus } : {}),
          };
          if (Object.keys(patch).length) changeLane(transport.liveKey, lanes, patch);
          if (a.bus !== undefined) await changeLaneRoute(transport.liveKey, transport.fetchPayload, lanes, a.bus ?? undefined);
          return;
        }
        case 'busSetting': {
          if (!pro.pro || !resolved) throw new Error('Pro mode is off: press Pro to change the mix.');
          const chain = resolved.mix.config.rackChains.find((c) => c.bus === a.bus);
          const params = pro.mix.buses[a.bus]?.[String(a.slot)] ?? chain?.plugins[a.slot]?.params;
          if (!params) throw new Error(`The ${a.bus} bus has no plugin in slot ${a.slot}.`);
          changeBusParam(transport.liveKey, a.bus, a.slot, params, a.param, a.value);
          return;
        }
        case 'resetMix':
          if (!pro.pro) throw new Error('Pro mode is off: press Pro to change the mix.');
          await resetProMix(transport.liveKey, transport.fetchPayload);
          return;
      }
    },
    [transport, sectionSpan, applyEdit, save, rename, render, navigate, songId, viewSong, setActiveSong, queryClient, pro, resolved],
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
    <aside className="flex w-[380px] shrink-0 flex-col border-l border-black/70 bg-[#1e1f23] text-white" style={CHAT_THEME} aria-label="Song assistant">
      <div className="flex items-center gap-2 border-b border-black/60 px-3 py-2">
        <span className="text-[14px] font-semibold">Assistant</span>
        <span className="text-[12px] text-white/45">{pro.pro ? (snapshot ? 'edits this song and its mix' : 'reading the mix…') : 'edits this song'}</span>
        <button type="button" onClick={() => setChatKey((k) => k + 1)} className="ml-auto h-7 rounded-full border border-white/20 px-3 text-[12px] text-white/70 hover:border-white/60 hover:text-white" title="Start a new conversation">
          New chat
        </button>
        <button type="button" onClick={onClose} className="h-7 w-7 rounded-full border border-white/20 text-[12px] text-white/70 hover:border-white/60 hover:text-white" aria-label="Close the assistant" title="Close the assistant">
          ✕
        </button>
      </div>
      {mixError ? (
        <p className="border-b border-black/60 bg-err/10 px-3 py-2 text-[12px] text-red-200" role="alert">
          {mixError}
        </p>
      ) : null}
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
          extraBody={{ songId, song: viewSong, title: viewSong?.title, ...(snapshot ? { mix: snapshot } : {}) }}
          onToolResult={onToolResult}
          placeholder="Message the assistant"
          className="casperaki-chat h-full"
        />
      </div>
    </aside>
  );
}
