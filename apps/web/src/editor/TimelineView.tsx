import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@teamsuzie/ui';

import { soundsApi, soundsQueryKeys } from '../api/sounds';
import { livePlayer, patternPlayer, type LaneMeters, type MixConfigJson, type ResolvedMix, type SampledAutomation } from '../audio/livePlayer';
import { fnv1a, useLiveTransport } from '../audio/useLiveTransport';
import { useLivePosition, useLiveState } from '../audio/useLivePlayer';
import { playbackApi } from '../api/playback';
import { resolveEngineEvents, resolveEngineNotes } from '../audio/resolveNotes';
import type { PlaybackPayload } from '../api/playback';
import { downloadBytes, fileStem } from '../export/exportMidi';
import type { ExportItem } from '../export/ExportMenu';
import { buildSongMidi } from '../export/midi';
import { encodeWav24 } from '../export/wav';
import { drumBarNotes, patternSong, trackSong } from './sequencer/preview';
import { TrackOverview } from './sequencer/TrackOverview';
import { drumBarPattern } from './sequencer/ClipDetail';
import { indexInstrumentDefinitions } from '../types/song';
import { useSession } from '../state/session';
import { BEATS_PER_BAR, buildSequencerModel, type SeqNote, type SeqSection, type SeqTrack } from './sequencerModel';
import { ClipDetail } from './sequencer/ClipDetail';
import { ADD_ROW_H, BARS_H, CHORD_H, HEADER_W, LOOP_H, MARKERS_H, MAX_PX_PER_BAR, MAX_ROW_H, MIN_PX_PER_BAR, MIN_ROW_H, RULER_H, TIME_H, TRACK_DIVIDER_H } from './sequencer/layout';
import { beginRangeDrag } from './sequencer/rangeDrag';
import { SelectionOverlay } from './sequencer/Selection';
import { fmtBar, Ruler, type BarRange } from './sequencer/Ruler';
import { ChordLane } from './sequencer/ChordLane';
import { Mixer, ProBar, type OpenDevice } from './sequencer/Mixer';
import { Transport } from '../layout/Transport';
import { DeviceWindow } from './devices/DeviceWindow';
import { Logical4Panel } from './devices/Logical4Panel';
import { DevicePanel } from './devices/DevicePanel';
import { ReverbPanel } from './devices/ReverbPanel';
import { DEVICES } from './devices/deviceDefs';
import { ProParams } from './devices/ProParams';
import { changeBusParam, openProMix, resetProMix, useProMix } from '../audio/proMix';
import { TrackCanvas } from './sequencer/TrackCanvas';
import { AddTrackDialog, ChangeSoundDialog, DrumSoundDialog } from './sequencer/TrackDialogs';
import { AddSectionDialog, RenameSectionDialog } from './sequencer/SectionDialogs';
import { TransitionsWindow } from './sequencer/TransitionsWindow';
import { tracksApi, type DrumKitRow } from '../api/tracks';
import { useTrackEdits } from './sequencer/useTrackEdits';

type Dialog =
  | { kind: 'detail'; track: string; section: number }
  | { kind: 'overview'; track: string }
  | { kind: 'sound'; track: string }
  | { kind: 'add'; sections: string[] };

/** Tracks 60 % / mixer 40 % of the view by default. */
const DEFAULT_MIXER_SHARE = 0.4;
const MENU = 'z-50 min-w-[220px] rounded-[10px] border border-line bg-panel p-1 text-white shadow-2xl';
const ITEM = 'cursor-pointer rounded-[6px] px-3 py-2 text-[14px] outline-none data-[highlighted]:bg-white/10 data-[disabled]:opacity-40';

/**
 * Sequencer (Timeline tab): the whole song on one time axis, laid out like a
 * DAW. The ruler shows sections, bars|beats and minutes:seconds; drag across
 * its bottom strip to choose a loop range. Each track is a row with a clip
 * per section it plays in. Double-click a clip to look inside it (drum grid
 * or piano roll); right-click a track for its menu (open, loop, change the
 * sound, new pattern, remove, add a track).
 */
export function TimelineView() {
  const { viewSong, activeSong, activeSegment, setActiveSegment, applyEdit, editor } = useSession();
  const model = useMemo(() => (viewSong ? buildSequencerModel(viewSong) : undefined), [viewSong]);
  const defs = useMemo(() => indexInstrumentDefinitions(viewSong), [viewSong]);
  const { currentSeconds, playing, isThisSong, seek, liveKey, fetchPayload, editorDirty, live, playPause } = useLiveTransport();
  const edits = useTrackEdits(liveKey);
  const [meters, setMeters] = useState<LaneMeters | undefined>(undefined);
  const [metersError, setMetersError] = useState<string | undefined>(undefined);
  // The mix as the engine resolves it, read straight from the lowered song (fast).
  const [mix, setMix] = useState<ResolvedMix | undefined>(undefined);
  const [mixError, setMixError] = useState<string | undefined>(undefined);
  /** The standard mix's FX bus chains (Pro mode marks and resets plugin changes against them). */
  const [standardChains, setStandardChains] = useState<MixConfigJson['rackChains'] | undefined>(undefined);
  // Pro mode: the song's own mix changes (saved with the project).
  const pro = useProMix();
  useEffect(() => {
    if (activeSong) openProMix(activeSong.id, activeSong.project.mixOverrides);
  }, [activeSong]);
  useEffect(() => {
    setMix(undefined);
    setMixError(undefined);
    if (!liveKey) return;
    let cancelled = false;
    const t = setTimeout(() => {
      livePlayer.mixOf(liveKey, fetchPayload).then(
        (m) => !cancelled && setMix(m),
        (err: unknown) => !cancelled && setMixError(err instanceof Error ? err.message : String(err)),
      );
      livePlayer.payloadOf(liveKey, fetchPayload).then(
        (p) => !cancelled && setStandardChains(p.standardRackChains),
        (err: unknown) => !cancelled && setMixError(err instanceof Error ? err.message : String(err)),
      );
    }, editorDirty ? 1200 : 0);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [liveKey, fetchPayload, editorDirty, pro.version]);
  const [dialog, setDialog] = useState<Dialog | undefined>(undefined);
  /** The section dialogs (from the ruler's right-click menu). */
  const [sectionDialog, setSectionDialog] = useState<
    { kind: 'rename'; name: string } | { kind: 'add'; index: number; where: string } | { kind: 'transitions'; name: string } | undefined
  >(undefined);
  /** The open device view (a plugin on a bus), if any. */
  const [device, setDevice] = useState<OpenDevice | undefined>(undefined);
  // The engine's automation per track (filter sweeps, volume fades), from the resolved mix.
  const automationByTrack = useMemo(() => {
    const m = new Map<string, { lowPass?: SampledAutomation; volume?: SampledAutomation }>();
    for (const l of mix?.lanes ?? []) {
      if (!l.lowPass && !l.volume) continue;
      const cur = m.get(l.lane) ?? {};
      m.set(l.lane, { lowPass: cur.lowPass ?? l.lowPass, volume: cur.volume ?? l.volume });
    }
    return m;
  }, [mix]);
  const soundNames = useSoundNames((model?.tracks ?? []).map((t) => ({ name: t.name, catalogId: catalogIdOf(defs.get(t.name)?.id) })));
  const detailSound = useSoundName(dialog?.kind === 'detail' ? catalogIdOf(defs.get(dialog.track)?.id) : undefined);
  // The drum kit (each drum's sound), while a drum pattern is open.
  const drumsOpen = dialog?.kind === 'detail' && dialog.track.toLowerCase().startsWith('drum');
  const drumsDef = drumsOpen ? defs.get(dialog.track) : undefined;
  const drumKit = useQuery({
    queryKey: ['drum-kit', viewSong?.genre, JSON.stringify(drumsDef ?? null)],
    queryFn: ({ signal }) => {
      if (!viewSong) throw new Error('No song is open.');
      return tracksApi.drumKit(viewSong, signal);
    },
    enabled: Boolean(drumsOpen && viewSong),
    staleTime: Infinity,
  });
  const [drumDialog, setDrumDialog] = useState<DrumKitRow | undefined>(undefined);
  // Every section's transitions with their sounds, while the transitions window is open.
  const transitionsOpen = sectionDialog?.kind === 'transitions';
  const transitionState = useQuery({
    queryKey: ['transition-state', JSON.stringify(viewSong ? Object.fromEntries(Object.entries(viewSong.arrangement).map(([k, v]) => [k, v.transitions ?? {}])) : null), viewSong?.songStructure.map((x) => x.name).join(',')],
    queryFn: ({ signal }) => {
      if (!viewSong) throw new Error('No song is open.');
      return tracksApi.transitionState(viewSong, signal);
    },
    enabled: Boolean(transitionsOpen && viewSong),
    staleTime: Infinity,
    placeholderData: (prev) => prev,
  });
  const [selectedTrack, setSelectedTrack] = useState<string | undefined>(undefined);
  /** Where the last right-click landed: which track, which section. */
  const [menuAt, setMenuAt] = useState<{ track: string; section: number | undefined; inSelection: boolean } | undefined>(undefined);

  // Per-track waveforms: measured in a background worker for the version on
  // screen (a moment after editing stops), filling in as it runs.
  useEffect(() => {
    setMeters(undefined);
    setMetersError(undefined);
    if (!liveKey) return;
    let cancel: (() => void) | undefined;
    const t = setTimeout(() => {
      cancel = livePlayer.meters(liveKey, fetchPayload, setMeters, setMetersError);
    }, editorDirty ? 1500 : 0);
    return () => {
      clearTimeout(t);
      cancel?.();
    };
  }, [liveKey, fetchPayload, editorDirty]);
  const meterMax = useMemo(() => {
    let m = 0;
    for (const arr of meters?.peaks ?? []) for (const v of arr) if (v > m) m = v;
    return m;
  }, [meters]);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [pxPerBar, setPxPerBar] = useState<number | undefined>(undefined);
  // Row height: every track fits the space between the ruler and the mixer.
  const [areaH, setAreaH] = useState(0);
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAreaH(el.clientHeight));
    ro.observe(el);
    setAreaH(el.clientHeight);
    return () => ro.disconnect();
  }, [viewSong]);
  const trackCount = model?.tracks.length ?? 0;
  // Vertical zoom scales the fitted height (1 = every track fits).
  const [vZoom, setVZoom] = useState(1);
  const fittedRowH = trackCount
    ? Math.max(MIN_ROW_H, Math.min(MAX_ROW_H, Math.floor((areaH - RULER_H - ADD_ROW_H - CHORD_H - 14) / trackCount) - TRACK_DIVIDER_H))
    : MAX_ROW_H;
  const rowH = Math.max(18, Math.min(220, Math.round(fittedRowH * vZoom)));
  const [follow, setFollow] = useState(true);
  const [mixerOpen, setMixerOpen] = useState(() => readPref('casperaki.mixerOpen', true));
  // Mixer height as a share of the view (default 40 %: tracks 60 / mixer 40); drag the
  // divider to change it, remembered as a share so it fits any window.
  const [mixerShare, setMixerShare] = useState(() => readNumberPref('casperaki.mixerShare', DEFAULT_MIXER_SHARE));
  const rootRef = useRef<HTMLDivElement>(null);
  const [rootH, setRootH] = useState(0);
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setRootH(el.clientHeight));
    ro.observe(el);
    setRootH(el.clientHeight);
    return () => ro.disconnect();
    // Re-measure once the song is there (before it, a placeholder renders without the ref).
  }, [viewSong !== undefined]);
  /** The share at which the mixer fills the view but for the toolbar and a little of the tracks. */
  const largeShare = rootH > 0 ? Math.max(DEFAULT_MIXER_SHARE, (rootH - 160) / rootH) : 0.8;
  const mixerH = Math.round(Math.max(150, Math.min(Math.max(150, rootH - 160), (rootH || 900) * mixerShare)));
  const showMixer = useCallback((open: boolean, share?: number) => {
    setMixerOpen(open);
    writePref('casperaki.mixerOpen', open);
    if (share !== undefined) {
      setMixerShare(share);
      writeNumberPref('casperaki.mixerShare', share);
    }
  }, []);
  /** Double-click on the divider: default (60/40) → large → hidden (X or the Mixer button bring it back). */
  const cycleMixer = () => {
    if (Math.abs(mixerShare - DEFAULT_MIXER_SHARE) < 0.02) showMixer(true, largeShare);
    else if (mixerShare >= largeShare - 0.02) showMixer(false, DEFAULT_MIXER_SHARE);
    else showMixer(true, DEFAULT_MIXER_SHARE);
  };
  const startMixerDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if (rootH <= 0) throw new Error('The track view has no height yet.');
    e.preventDefault();
    const y0 = e.clientY;
    const h0 = mixerH;
    let share = mixerShare;
    const move = (ev: PointerEvent) => {
      const h = Math.max(150, Math.min(rootH - 160, h0 + (y0 - ev.clientY)));
      share = h / rootH;
      setMixerShare(share);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.cursor = '';
      writeNumberPref('casperaki.mixerShare', share);
    };
    document.body.style.cursor = 'row-resize';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const toggleMixer = useCallback(() => {
    setMixerOpen((o) => {
      writePref('casperaki.mixerOpen', !o);
      return !o;
    });
  }, []);
  // X shows or hides the mixer (as in Logic); Shift+X switches between the
  // tracks filling the view and the mixer filling it.
  const mixerFull = mixerOpen && mixerShare >= largeShare - 0.02;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'KeyX' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
      e.preventDefault();
      if (!e.shiftKey) toggleMixer();
      else if (mixerFull) showMixer(false);
      else showMixer(true, largeShare);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const bpm = viewSong?.bpm ?? 120;
  const secondsPerBar = (BEATS_PER_BAR * 60) / bpm;

  const fit = useCallback(() => {
    const el = scrollerRef.current;
    if (!el || !model || model.totalBars === 0) return;
    const fitted = (el.clientWidth - HEADER_W - 24) / model.totalBars;
    setPxPerBar(Math.min(MAX_PX_PER_BAR, Math.max(MIN_PX_PER_BAR, fitted)));
  }, [model]);

  // Start fitted to the window.
  useLayoutEffect(() => {
    if (pxPerBar === undefined) fit();
  }, [fit, pxPerBar]);

  const px = pxPerBar ?? 24;
  const playheadBar = isThisSong ? currentSeconds / secondsPerBar : 0;
  const playheadX = HEADER_W + playheadBar * px;

  // Keep the playhead in view while playing.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || !follow || !playing) return;
    const left = el.scrollLeft + HEADER_W;
    const right = el.scrollLeft + el.clientWidth - 80;
    if (playheadX < left || playheadX > right) el.scrollLeft = Math.max(0, playheadX - HEADER_W - 120);
  }, [playheadX, follow, playing]);

  const range: BarRange | undefined = live.loopRange
    ? { start: live.loopRange.start / secondsPerBar, end: live.loopRange.end / secondsPerBar }
    : undefined;
  const setRange = useCallback(
    (r: BarRange | undefined) => livePlayer.setLoopRange(r ? { start: r.start * secondsPerBar, end: r.end * secondsPerBar } : undefined),
    [secondsPerBar],
  );

  const selectionMenu: SelectionActions = {
    label: range ? `Selection ${fmtBar(range.start)} – ${fmtBar(range.end)}` : '',
    looping: live.looping,
    onLoop: () => {
      if (!range) return;
      livePlayer.setLooping(true);
      if (!playing) {
        if (liveKey && livePlayer.isLoaded(liveKey)) playPause();
        else seek(range.start * secondsPerBar);
      }
    },
    onPlay: () => {
      if (!range) return;
      seek(range.start * secondsPerBar);
      if (!playing && liveKey && livePlayer.isLoaded(liveKey)) playPause();
    },
    onClear: () => setRange(undefined),
  };

  const detailOpen = dialog?.kind === 'detail' ? dialog : undefined;
  // The open track's pattern in the open section, as a song of its own: what
  // the detail window plays. Drums: exactly the bar shown (the bar the engine repeats).
  const preview = useMemo(() => {
    if (!viewSong || !model || !detailOpen) return undefined;
    const sec = model.sections[detailOpen.section];
    const t = model.tracks.find((x) => x.name === detailOpen.track);
    const clip = t?.clips.find((c) => c.section === detailOpen.section);
    if (!sec || !t || !clip) return undefined;
    const song = t.isDrums
      ? patternSong(viewSong, sec.name, t.name, {
          bars: 1,
          overrideBars: [drumBarNotes(drumBarPattern(clip.notes.map((n) => ({ ...n, start: n.start - clip.startBar * BEATS_PER_BAR })), clip.bars))],
        })
      : patternSong(viewSong, sec.name, t.name);
    return { song, track: t.name, isVocal: t.isVocal, key: `preview:${fnv1a(JSON.stringify(song))}` };
  }, [viewSong, model, detailOpen]);
  // Sung parts play on a piano (the engine does not sing yet).
  const [previewPiano, setPreviewPiano] = useState<string | undefined>(undefined);
  const fetchPreview = useCallback(
    async (signal: AbortSignal) => {
      if (!preview) throw new Error('No section is open.');
      if (!preview.isVocal) return playbackApi.forSong(preview.song, signal);
      const piano = await tracksApi.vocalAsPiano(preview.song, preview.track, signal);
      setPreviewPiano(piano.pianoName);
      return playbackApi.forSong(piano.song, signal);
    },
    [preview],
  );
  // The detail window has its own player (patternPlayer): its loop, playhead
  // and transport have nothing to do with the song's.
  const pattern = useLiveState(patternPlayer);
  // (While an edit is swapped in, the previous version keeps playing: still "playing".)
  const previewPlaying = pattern.status === 'playing';
  const previewLoaded = pattern.key !== undefined && pattern.status !== 'loading' && pattern.status !== 'idle';
  const previewSeconds = useLivePosition(pattern.status === 'playing', patternPlayer);

  // What the engine plays for the open pattern (pitched tracks): its own
  // resolver's notes, so the piano roll shows chord voicings exactly as heard.
  const [engineNotes, setEngineNotes] = useState<{ key: string; notes: SeqNote[] } | { key: string; error: string } | undefined>(undefined);
  useEffect(() => {
    if (!preview || !detailOpen || model?.tracks.find((t) => t.name === detailOpen.track)?.isDrums) return;
    let cancelled = false;
    patternPlayer
      .payloadOf(preview.key, fetchPreview)
      .then(resolveEngineNotes)
      .then(
        (notes) =>
          !cancelled &&
          setEngineNotes({
            key: preview.key,
            notes: notes.map((n) => ({ start: n.start, length: n.length, pitch: n.pitch, kind: 'note' as const, velocity: n.velocity })),
          }),
        (err: unknown) => !cancelled && setEngineNotes({ key: preview.key, error: err instanceof Error ? err.message : String(err) }),
      );
    return () => {
      cancelled = true;
    };
  }, [preview, detailOpen, model, fetchPreview]);

  // The whole-track view: the engine's notes for the track alone, across the song.
  const overviewTrack = dialog?.kind === 'overview' ? dialog.track : undefined;
  const [overviewNotes, setOverviewNotes] = useState<{ track: string; notes: SeqNote[] } | { track: string; error: string } | undefined>(undefined);
  useEffect(() => {
    if (!viewSong || !overviewTrack) return;
    let cancelled = false;
    const song = trackSong(viewSong, overviewTrack);
    livePlayer
      .payloadOf(`track:${fnv1a(JSON.stringify(song))}`, (signal) => playbackApi.forSong(song, signal))
      .then(resolveEngineNotes)
      .then(
        (notes) =>
          !cancelled &&
          setOverviewNotes({
            track: overviewTrack,
            notes: notes.map((n) => ({ start: n.start, length: n.length, pitch: n.pitch, kind: 'note' as const, velocity: n.velocity })),
          }),
        (err: unknown) => !cancelled && setOverviewNotes({ track: overviewTrack, error: err instanceof Error ? err.message : String(err) }),
      );
    return () => {
      cancelled = true;
    };
  }, [viewSong, overviewTrack]);

  const songTitle = activeSong?.project.title ?? 'Untitled';
  /** Export a lowered song (a pattern, a track) as MIDI or WAV, from the given player's cache. */
  const exportItemsFor = (
    player: typeof livePlayer,
    key: string,
    fetch: (signal: AbortSignal) => Promise<PlaybackPayload>,
    what: { track: string; sections: { name: string; startBar: number }[]; fileName: string },
  ): ExportItem[] => [
    {
      label: 'MIDI',
      hint: 'as played',
      run: async () => {
        if (!viewSong) throw new Error('No song is open.');
        const events = await resolveEngineEvents(await player.payloadOf(key, fetch));
        const bytes = buildSongMidi(events, { title: what.fileName, key: viewSong.key, instruments: [what.track], sections: what.sections });
        downloadBytes(bytes, `${fileStem(what.fileName)}.mid`, 'audio/midi');
      },
    },
    {
      label: 'Audio (WAV)',
      hint: '24-bit, with effects',
      run: async (progress) => {
        const pcm = await player.renderAudio(key, fetch, progress);
        downloadBytes(encodeWav24(pcm.left, pcm.right, pcm.sampleRate), `${fileStem(what.fileName)}.wav`, 'audio/wav');
      },
    },
  ];

  /** The detail window's Play: loop `from`–`to` (seconds into the pattern). */
  const playPreview = useCallback(
    (from: number, to: number) => {
      if (!preview) throw new Error('No pattern is open.');
      // One thing plays at a time: the song pauses where it is.
      void livePlayer.pause();
      patternPlayer.setLoopRange({ start: from, end: to });
      patternPlayer.setLooping(true);
      if (patternPlayer.isLoaded(preview.key)) patternPlayer.seek(from);
      void patternPlayer.play(preview.key, fetchPreview);
    },
    [preview, fetchPreview],
  );

  // An edit while the pattern plays: render the new version and switch to it
  // at the same position, without stopping.
  useEffect(() => {
    if (!preview) return;
    const st = patternPlayer.getState();
    if (st.status !== 'playing' || st.key === preview.key) return;
    void patternPlayer.play(preview.key, fetchPreview, { seamless: true });
  }, [preview, fetchPreview]);

  /** Leaving the detail window: stop its player. The song's is untouched. */
  const endPreview = useCallback(() => {
    patternPlayer.stop();
    patternPlayer.setLoopRange(undefined);
  }, []);

  const loopSection = useCallback(
    (sec: SeqSection) => {
      setRange({ start: sec.startBar, end: sec.startBar + sec.bars });
      livePlayer.setLooping(true);
      setActiveSegment(sec.name);
      if (!playing) {
        if (liveKey && livePlayer.isLoaded(liveKey)) {
          livePlayer.seek(sec.startBar * secondsPerBar);
          playPause();
        } else seek(sec.startBar * secondsPerBar);
      }
    },
    [setRange, setActiveSegment, playing, liveKey, secondsPerBar, playPause, seek],
  );

  if (!viewSong || !model) {
    return <div className="flex h-full items-center justify-center text-[15px] text-muted">No song loaded.</div>;
  }

  const width = model.totalBars * px;
  const sectionIndexAt = (bar: number) => model.sections.findIndex((s) => bar >= s.startBar && bar < s.startBar + s.bars);
  const barFromEvent = (e: ReactMouseEvent<HTMLElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(model.totalBars, (e.clientX - rect.left) / px));
  };
  const zoom = (factor: number) => setPxPerBar(Math.min(MAX_PX_PER_BAR, Math.max(MIN_PX_PER_BAR, px * factor)));
  const editable = (track: string) => edits.options.data?.tracks[track]?.editable === true;
  /** Whether other sounds can be offered (drum kits are fixed per genre). */
  const canChangeSound = (track: string) => {
    const info = edits.options.data?.tracks[track];
    if (!info?.editable || !info.family) return false;
    return (edits.options.data?.families.find((f) => f.family === info.family)?.sounds.length ?? 0) > 0;
  };
  const openDetail = (track: SeqTrack, section: number) => {
    if (track.clips.some((c) => c.section === section)) setDialog({ kind: 'detail', track: track.name, section });
  };

  const detail = dialog?.kind === 'detail' ? dialog : undefined;
  const detailTrack = detail ? model.tracks.find((t) => t.name === detail.track) : undefined;
  const detailClip = detail && detailTrack ? detailTrack.clips.find((c) => c.section === detail.section) : undefined;

  const newPattern = (track: string) => void edits.run({ kind: 'newPattern', track }, `New pattern for ${track}`);

  return (
    <div ref={rootRef} className="flex h-full flex-col text-white">
      <div className="flex shrink-0 items-center gap-2 border-b border-line/50 px-4 py-2 text-[13px]">
        <span className="mr-2 text-white/55">
          {model.tracks.length} tracks · {model.totalBars} bars · {Math.floor((model.totalBars * secondsPerBar) / 60)}:
          {String(Math.round(model.totalBars * secondsPerBar) % 60).padStart(2, '0')}
        </span>
        {range ? (
          <span className="mr-2 font-mono text-[12px] text-sky-300/90" title="Loop range (bars|beats)">
            Range {fmtBar(range.start)} – {fmtBar(range.end)}
          </span>
        ) : null}
        {edits.busy ? (
          <span className="flex items-center gap-2 text-white/70" role="status">
            <span className="h-2 w-2 animate-pulse rounded-full bg-white/60" aria-hidden="true" />
            {edits.busy}…
          </span>
        ) : editor?.lastError ? (
          <span className="text-err" role="alert">{editor.lastError}</span>
        ) : edits.error ? (
          <span className="flex items-center gap-2 text-err" role="alert">
            {edits.error}
            <button type="button" onClick={edits.clearError} className="text-white/60 hover:text-white" aria-label="Dismiss">
              ✕
            </button>
          </span>
        ) : meters && !meters.done ? (
          <span className="text-white/45" role="status">
            Measuring track levels {Math.round((meters.doneBins / Math.max(1, meters.binCount)) * 100)}%
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => setDialog({ kind: 'add', sections: model.sections.map((s) => s.name) })}
            disabled={!edits.options.data || Boolean(edits.busy)}
            className="mr-3 h-8 rounded-full border border-white/30 px-3.5 text-[13px] font-semibold text-white hover:border-white/60 disabled:opacity-40"
          >
            + Add track
          </button>
          <span className="mr-1 text-[12px] text-white/55">Width</span>
          <ToolButton onClick={() => zoom(1 / 1.5)} label="Zoom out">−</ToolButton>
          <ToolButton onClick={() => zoom(1.5)} label="Zoom in">+</ToolButton>
          <span className="ml-2 mr-1 text-[12px] text-white/55">Height</span>
          <ToolButton onClick={() => setVZoom((z) => Math.max(0.5, z / 1.25))} label="Tracks lower">−</ToolButton>
          <ToolButton onClick={() => setVZoom((z) => Math.min(4, z * 1.25))} label="Tracks taller">+</ToolButton>
          <ToolButton
            onClick={() => {
              fit();
              setVZoom(1);
            }}
            label="Fit the whole song and every track to the window"
          >
            Fit
          </ToolButton>
          <label className="ml-3 flex cursor-pointer items-center gap-2 text-white/70">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} className="accent-[#ff0000]" />
            Follow playhead
          </label>
          <button
            type="button"
            onClick={toggleMixer}
            aria-pressed={mixerOpen}
            title="Show or hide the mixer (X). Shift+X: tracks or mixer full view"
            className={`ml-3 h-8 rounded-[5px] border border-black/60 px-3 text-[12px] font-semibold ${mixerOpen ? 'bg-[#4a4c53] text-white' : 'bg-[#2b2c31] text-[#c4c5cb] hover:text-white'}`}
          >
            Mixer
          </button>
        </div>
      </div>

      <div ref={scrollerRef} className="relative min-h-0 flex-1 overflow-auto bg-[#18191c]">
        <div ref={contentRef} className="relative" style={{ width: HEADER_W + width, minHeight: '100%' }}>
          {/* Ruler. */}
          <div className="sticky top-0 z-30 bg-[#1b1c1f]" style={{ height: RULER_H + CHORD_H }}>
          <div className="flex" style={{ height: RULER_H }}>
            <div
              className="sticky left-0 z-40 flex shrink-0 flex-col border-b border-r border-line/60 bg-[#1b1c1f] px-3 text-[10px] text-white/40"
              style={{ width: HEADER_W }}
            >
              <span style={{ height: MARKERS_H, lineHeight: `${MARKERS_H}px` }}>Sections</span>
              <span style={{ height: BARS_H, lineHeight: `${BARS_H}px` }}>Bars|beats</span>
              <span style={{ height: TIME_H, lineHeight: `${TIME_H}px` }}>Min:sec</span>
              <span className="text-sky-300/70" style={{ height: LOOP_H, lineHeight: `${LOOP_H}px` }}>Loop (drag)</span>
            </div>
            <SelectionMenu selection={range ? selectionMenu : undefined}>
            <div className="border-b border-line/60">
              <Ruler
                model={model}
                px={px}
                secondsPerBar={secondsPerBar}
                activeSegment={activeSegment}
                range={range}
                looping={live.looping}
                onSeekBar={(bar) => seek(bar * secondsPerBar)}
                onSelectSection={setActiveSegment}
                onRangeChange={setRange}
                onMoveSection={(name, targetIndex) => applyEdit({ kind: 'moveSegment', segmentName: name, targetIndex })}
                onSectionAction={(action, name, index) => {
                  const sec = model.sections[index]!;
                  if (action === 'play') seek(sec.startBar * secondsPerBar);
                  else if (action === 'loop') loopSection(sec);
                  else if (action === 'rename') setSectionDialog({ kind: 'rename', name });
                  else if (action === 'transitions') setSectionDialog({ kind: 'transitions', name });
                  else if (action === 'duplicate') applyEdit({ kind: 'duplicateSegment', segmentName: name });
                  else if (action === 'addBar') applyEdit({ kind: 'changeBarCount', segmentName: name, delta: 1 });
                  else if (action === 'removeBar') applyEdit({ kind: 'changeBarCount', segmentName: name, delta: -1 });
                  else if (action === 'delete') applyEdit({ kind: 'deleteSegment', segmentName: name });
                  else setSectionDialog({ kind: 'add', index: action === 'addBefore' ? index : index + 1, where: `${action === 'addBefore' ? 'Before' : 'After'} ${name}` });
                }}
              />
            </div>
            </SelectionMenu>
            {isThisSong && playheadX >= HEADER_W ? (
              <span
                className="pointer-events-none absolute top-[22px] z-[35] h-0 w-0 -translate-x-1/2 border-x-[6px] border-t-[8px] border-x-transparent border-t-accent"
                style={{ left: playheadX + 0.5 }}
                aria-hidden="true"
              />
            ) : null}
          </div>
          {/* Chords, under the ruler and sticky with it. */}
          <div className="flex border-b border-line/60" style={{ height: CHORD_H }}>
            <div
              className="sticky left-0 z-40 flex shrink-0 items-center border-r border-line/60 bg-[#1b1c1f] px-3 text-[10px] text-white/40"
              style={{ width: HEADER_W }}
            >
              Chords
            </div>
            <ChordLane
              model={model}
              px={px}
              playheadBar={isThisSong ? playheadBar : undefined}
              onSeekBar={(bar) => seek(bar * secondsPerBar)}
              onRangeChange={setRange}
            />
          </div>
          </div>

          {/* The selection across the tracks (drag its edges to adjust). */}
          {range ? (
            <SelectionOverlay
              range={range}
              pxPerUnit={px}
              total={model.totalBars}
              offsetPx={HEADER_W}
              top={RULER_H + CHORD_H}
              looping={live.looping}
              originX={() => contentRef.current!.getBoundingClientRect().left + HEADER_W}
              onChange={setRange}
            />
          ) : null}

          {model.tracks.map((t, i) => (
            <TrackMenu
              key={t.name}
              track={t}
              section={menuAt?.track === t.name ? menuAt.section : undefined}
              selection={menuAt?.track === t.name && menuAt.inSelection ? selectionMenu : undefined}
              sections={model.sections}
              editable={editable(t.name)}
              soundChangeable={canChangeSound(t.name)}
              busy={Boolean(edits.busy) || !edits.options.data}
              onOpen={(s) => openDetail(t, s)}
              onLoop={(s) => loopSection(model.sections[s]!)}
              onChangeSound={() => setDialog({ kind: 'sound', track: t.name })}
              onNewPattern={() => newPattern(t.name)}
              onRemove={() => edits.removeTrack(t.name)}
              onOverview={t.isDrums ? undefined : () => setDialog({ kind: 'overview', track: t.name })}
              onAdd={(s) =>
                setDialog({ kind: 'add', sections: s === undefined ? model.sections.map((x) => x.name) : [model.sections[s]!.name] })
              }
            >
              <div
                className={`relative flex flex-col ${i % 2 ? 'bg-white/[0.015]' : ''}`}
                style={{ height: rowH + TRACK_DIVIDER_H }}
                onContextMenu={(e) => {
                  const lane = (e.target as HTMLElement).closest('[data-lane]');
                  const bar = lane ? (e.clientX - lane.getBoundingClientRect().left) / px : undefined;
                  const s = bar === undefined ? -1 : sectionIndexAt(bar);
                  setMenuAt({
                    track: t.name,
                    section: s >= 0 && t.clips.some((c) => c.section === s) ? s : undefined,
                    inSelection: Boolean(range && bar !== undefined && bar >= range.start && bar <= range.end),
                  });
                  setSelectedTrack(t.name);
                }}
              >
                <div className="flex" style={{ height: rowH }}>
                <div
                  className={`sticky left-0 z-10 flex shrink-0 cursor-default items-center gap-2.5 border-b border-r border-line/40 pr-3 ${
                    selectedTrack === t.name ? 'bg-[#3a3c43]' : 'bg-[#2a2b30]'
                  }`}
                  style={{ width: HEADER_W }}
                  onClick={() => setSelectedTrack(t.name)}
                >
                  <span className="h-full w-[4px] shrink-0" style={{ background: t.color }} aria-hidden="true" />
                  <span className="w-4 shrink-0 text-right font-mono text-[11px] text-white/35">{i + 1}</span>
                  <TrackName
                    name={t.name}
                    catalogId={catalogIdOf(defs.get(t.name)?.id)}
                    notPlayed={Boolean(meters?.done && !meters.names.includes(t.name))}
                  />
                  <MuteSolo lane={t.name} muted={live.muted.includes(t.name)} solo={live.solo.includes(t.name)} anySolo={live.solo.length > 0} />
                </div>
                <div
                  data-lane
                  className="relative shrink-0 cursor-pointer border-b border-line/25"
                  style={{ width }}
                  onPointerDown={(e) =>
                    beginRangeDrag(e, {
                      el: e.currentTarget,
                      pxPerBar: px,
                      totalBars: model.totalBars,
                      onRange: setRange,
                      onClick: (bar) => {
                        setSelectedTrack(t.name);
                        const s = sectionIndexAt(bar);
                        if (s >= 0) setActiveSegment(model.sections[s]!.name);
                      },
                    })
                  }
                  onDoubleClick={(e) => {
                    const s = sectionIndexAt(barFromEvent(e));
                    if (s >= 0) openDetail(t, s);
                  }}
                  title="Drag to select a range · double-click a clip to open it · right-click for more"
                >
                  <TrackCanvas
                    track={t}
                    model={model}
                    px={px}
                    secondsPerBar={secondsPerBar}
                    peaks={meters?.peaks[meters.names.indexOf(t.name)]}
                    binSec={meters?.binSec ?? 0}
                    meterMax={meterMax}
                    dimmed={live.solo.length > 0 ? !live.solo.includes(t.name) : live.muted.includes(t.name)}
                    selectedSection={selectedTrack === t.name ? model.sections.findIndex((s) => s.name === activeSegment) : undefined}
                    rowH={rowH}
                    automation={automationByTrack.get(t.name)}
                  />
                </div>
                </div>
                {/* Divider between tracks: a dark channel with a hairline highlight. */}
                <div className="shrink-0 border-t border-black/80 bg-[#0e0f12] shadow-[inset_0_-1px_0_rgba(255,255,255,0.05)]" style={{ height: TRACK_DIVIDER_H }} aria-hidden="true" />
              </div>
            </TrackMenu>
          ))}

          {/* Add a track. */}
          <div className="relative flex" style={{ height: ADD_ROW_H }}>
            <div className="sticky left-0 z-10 flex shrink-0 items-center border-b border-r border-line/40 bg-[#2a2b30] px-4" style={{ width: HEADER_W }}>
              <button
                type="button"
                onClick={() => setDialog({ kind: 'add', sections: model.sections.map((s) => s.name) })}
                disabled={!edits.options.data || Boolean(edits.busy)}
                className="text-[13px] text-white/55 hover:text-white disabled:opacity-40"
              >
                + Add track
              </button>
            </div>
            <div className="shrink-0 border-b border-line/25" style={{ width }} />
          </div>

          {/* Playhead: a line through the tracks with a marker on the ruler. */}
          {isThisSong ? (
            <div
              className="pointer-events-none absolute top-0 bottom-0 z-20 w-px bg-accent shadow-[0_0_6px_rgba(255,0,0,0.6)]"
              style={{ left: playheadX }}
              aria-hidden="true"
            />
          ) : null}
        </div>
      </div>

      {/* The transport (play, stop, loop, position) and, on the right, the mix's Pro controls. */}
      <div className="flex shrink-0 items-center gap-3 border-t-2 border-black/80 bg-gradient-to-b from-[#34363c] to-[#2a2b30] px-3 py-1.5">
        <Transport />
        <div className="ml-auto">
          <ProBar pro={pro} onReset={() => void resetProMix(liveKey, fetchPayload)} />
        </div>
      </div>

      {mixerOpen ? (
        <div className="relative shrink-0 border-t border-black/80" style={{ height: mixerH }} aria-label="Mixer">
          {/* Divider: drag to share the height between tracks and mixer. */}
          <div
            className="absolute inset-x-0 -top-[5px] z-20 h-[8px] cursor-row-resize hover:bg-white/15"
            onPointerDown={startMixerDrag}
            onDoubleClick={cycleMixer}
            role="separator"
            aria-orientation="horizontal"
            aria-label="Drag to resize the mixer (double-click: default, large, hidden)"
            title="Drag to resize the mixer. Double-click: default → large → hidden. X shows/hides it; Shift+X: tracks or mixer full view"
          />
          <Mixer tracks={model.tracks} mix={mix} meters={meters} error={mixError ?? (mix ? undefined : metersError)} seconds={currentSeconds} playing={playing} muted={live.muted} solo={live.solo} soundNames={soundNames} onOpenDevice={setDevice} pro={pro} liveKey={liveKey} />
        </div>
      ) : null}

      {sectionDialog?.kind === 'rename' ? (
        <RenameSectionDialog
          name={sectionDialog.name}
          taken={model.sections.map((x) => x.name)}
          onClose={() => setSectionDialog(undefined)}
          onRename={(newName) => {
            applyEdit({ kind: 'renameSegment', segmentName: sectionDialog.name, newName });
            setSectionDialog(undefined);
          }}
        />
      ) : sectionDialog?.kind === 'transitions' ? (
        <TransitionsWindow
          songStyle={viewSong.genre}
          section={sectionDialog.name}
          sections={model.sections.map((x) => ({ name: x.name, kind: x.kind }))}
          state={transitionState.data ?? (transitionState.isError ? { error: transitionState.error.message } : undefined)}
          busy={edits.busy}
          error={edits.error}
          onSelectSection={(name) => setSectionDialog({ kind: 'transitions', name })}
          onClose={() => setSectionDialog(undefined)}
          onSet={(op) =>
            void edits.runSongEdit(op.on ? (op.soundId ? 'Changing the sound' : 'Adding the transition') : 'Removing the transition', async (song) =>
              (await tracksApi.setTransition(song, op)).song,
            )
          }
        />
      ) : sectionDialog?.kind === 'add' ? (
        <AddSectionDialog
          where={sectionDialog.where}
          onClose={() => setSectionDialog(undefined)}
          onAdd={(type, bars) => {
            const index = sectionDialog.index;
            setSectionDialog(undefined);
            void edits.runSongEdit('Writing a new section', async (song) => (await tracksApi.addSection(song, type, index, bars)).song);
          }}
        />
      ) : null}

      {device ? (() => {
        // In Pro mode the plugin shows (and plays) the song's own settings.
        const params = pro.mix.buses[device.bus]?.[String(device.slot)] ?? device.params;
        const standard = standardChains?.find((c) => c.bus === device.bus)?.plugins[device.slot]?.params;
        return (
        <DeviceWindow
          title={device.factory === 'makeLogical4' ? 'Logical4' : (DEVICES[device.factory]?.title ?? device.factory)}
          subtitle={`${device.bus === 'master' ? 'Master' : `${device.bus} bus`} · slot ${device.slot + 1}`}
          onClose={() => setDevice(undefined)}
        >
          {device.factory === 'makeLogical4' ? (
            <Logical4Panel key={`${device.bus}:${device.slot}`} bus={device.bus} slot={device.slot} params={params} />
          ) : DEVICES[device.factory]?.kind === 'reverb' ? (
            <ReverbPanel key={`${device.bus}:${device.slot}`} def={DEVICES[device.factory]!} factory={device.factory} bus={device.bus} slot={device.slot} params={params} />
          ) : DEVICES[device.factory] ? (
            <DevicePanel key={`${device.bus}:${device.slot}`} def={DEVICES[device.factory]!} bus={device.bus} slot={device.slot} params={params} bpm={bpm} />
          ) : (
            <p className="p-6 text-[13px] text-err">No device view for {device.factory}.</p>
          )}
          {pro.pro && standard ? (
            <ProParams
              factory={device.factory}
              params={params}
              standard={standard}
              onChange={(i, v) => changeBusParam(liveKey, device.bus, device.slot, params, i, v)}
            />
          ) : null}
        </DeviceWindow>
        );
      })() : null}

      {detail && detailTrack && detailClip ? (
        <ClipDetail
          track={detailTrack}
          clip={detailClip}
          section={model.sections[detail.section]!}
          sameKind={model.sections.filter((x) => x.kind === model.sections[detail.section]!.kind).map((x) => x.name)}
          onSetDrumHit={(segments, pitch, step, on) => applyEdit({ kind: 'setDrumHit', segments, pitch, step, on })}
          editError={editor?.lastError}
          engineNotes={
            detailTrack.isVocal
              ? { notes: detailClip.notes.filter((n) => n.pitch !== null).map((n) => ({ ...n, start: n.start - detailClip.startBar * BEATS_PER_BAR })) }
              : engineNotes && engineNotes.key === preview?.key
                ? engineNotes
                : undefined
          }
          notesFromSong={detailTrack.isVocal}
          pianoName={detailTrack.isVocal ? previewPiano : undefined}
          soundName={detailSound}
          drumKit={drumKit.data ?? (drumKit.isError ? { error: drumKit.error.message } : undefined)}
          onDrumSound={(row, action) =>
            action === 'replace'
              ? setDrumDialog(row)
              : void edits.run({ kind: 'setDrumSound', role: row.role, soundId: null }, `Putting the style's own ${row.label.toLowerCase()} back`)
          }
          songKey={viewSong.key}
          bpm={bpm}
          exportItems={
            preview
              ? exportItemsFor(patternPlayer, preview.key, fetchPreview, {
                  track: detailTrack.name,
                  sections: [{ name: model.sections[detail.section]!.name, startBar: 0 }],
                  fileName: `${songTitle} ${detailTrack.name} ${model.sections[detail.section]!.name}`,
                })
              : []
          }
          onClose={() => {
            endPreview();
            setDialog(undefined);
          }}
          previewPlaying={previewPlaying}
          previewBeat={previewLoaded ? (previewSeconds / secondsPerBar) * BEATS_PER_BAR : undefined}
          onPlay={(fromBeat, toBeat) =>
            playPreview((fromBeat / BEATS_PER_BAR) * secondsPerBar, (toBeat / BEATS_PER_BAR) * secondsPerBar)
          }
          onPause={() => void patternPlayer.pause()}
          onNewPattern={() => newPattern(detailTrack.name)}
          onChangeSound={() => setDialog({ kind: 'sound', track: detailTrack.name })}
          editable={editable(detailTrack.name)}
          soundChangeable={canChangeSound(detailTrack.name)}
          busy={Boolean(edits.busy)}
        />
      ) : null}
      {dialog?.kind === 'overview' ? (
        <TrackOverview
          track={model.tracks.find((t) => t.name === dialog.track)!}
          sections={model.sections}
          totalBars={model.totalBars}
          songTitle={songTitle}
          soundName={soundNames[dialog.track]}
          songKey={viewSong.key}
          bpm={bpm}
          notes={(() => {
            const t = model.tracks.find((x) => x.name === dialog.track)!;
            // Sung parts: the song's own notes (the engine does not sing yet), placed in song time.
            if (t.isVocal) return { notes: t.clips.flatMap((c) => c.notes.filter((n) => n.pitch !== null)) };
            return overviewNotes && overviewNotes.track === dialog.track ? overviewNotes : undefined;
          })()}
          playheadBeat={isThisSong && playing ? (currentSeconds / secondsPerBar) * BEATS_PER_BAR : undefined}
          onClose={() => setDialog(undefined)}
          exportItems={(() => {
            const song = trackSong(viewSong, dialog.track);
            return exportItemsFor(livePlayer, `track:${fnv1a(JSON.stringify(song))}`, (signal) => playbackApi.forSong(song, signal), {
              track: dialog.track,
              sections: model.sections.map((x) => ({ name: x.name, startBar: x.startBar })),
              fileName: `${songTitle} ${dialog.track}`,
            });
          })()}
        />
      ) : null}
      {drumDialog ? (
        <DrumSoundDialog
          row={drumDialog}
          songStyle={viewSong.genre}
          onClose={() => setDrumDialog(undefined)}
          onPick={(soundId, name) => {
            const row = drumDialog;
            setDrumDialog(undefined);
            void edits.run({ kind: 'setDrumSound', role: row.role, soundId }, `Putting ${name} in as ${row.label.toLowerCase()}`);
          }}
        />
      ) : null}
      {dialog?.kind === 'sound' && edits.options.data ? (
        <ChangeSoundDialog
          track={dialog.track}
          songStyle={viewSong.genre}
          options={edits.options.data}
          onClose={() => setDialog(undefined)}
          onPick={(soundId) => {
            setDialog(undefined);
            void edits.run({ kind: 'changeSound', track: dialog.track, soundId }, `Changing the sound of ${dialog.track}`);
          }}
        />
      ) : null}
      {dialog?.kind === 'add' && edits.options.data ? (
        <AddTrackDialog
          options={edits.options.data}
          hasDrums={model.tracks.some((t) => t.name === 'Drums')}
          sections={model.sections}
          initialSections={dialog.sections}
          onClose={() => setDialog(undefined)}
          onAdd={(family, segments, soundId) => {
            setDialog(undefined);
            void edits.run({ kind: 'addTrack', family, segments, ...(soundId ? { soundId } : {}) }, 'Adding a track');
          }}
        />
      ) : null}
    </div>
  );
}

/** Right-click menu for a track row. `section` is the clip under the pointer, if any. */
function TrackMenu({
  track,
  section,
  selection,
  sections,
  editable,
  soundChangeable,
  busy,
  onOpen,
  onLoop,
  onChangeSound,
  onNewPattern,
  onRemove,
  onAdd,
  onOverview,
  children,
}: {
  track: SeqTrack;
  section: number | undefined;
  /** Set when the right-click landed inside the selected range. */
  selection: SelectionActions | undefined;
  sections: readonly SeqSection[];
  editable: boolean;
  soundChangeable: boolean;
  busy: boolean;
  onOpen(section: number): void;
  onLoop(section: number): void;
  onChangeSound(): void;
  onNewPattern(): void;
  onRemove(): void;
  onAdd(section: number | undefined): void;
  /** Whole-track piano roll / score (pitched tracks). */
  onOverview: (() => void) | undefined;
  children: ReactNode;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className={MENU}>
        <ContextMenuLabel className="px-3 py-2 text-[12px] font-normal text-white/50">
          {track.name}
          {section !== undefined ? ` · ${sections[section]!.name}` : ''}
        </ContextMenuLabel>
        {selection ? (
          <>
            <SelectionItems selection={selection} />
            <ContextMenuSeparator className="my-1 h-px bg-line" />
          </>
        ) : null}
        {section !== undefined ? (
          <>
            <ContextMenuItem className={ITEM} onSelect={() => onOpen(section)}>
              Open <span className="ml-auto pl-6 text-[12px] text-white/40">Double-click</span>
            </ContextMenuItem>
            <ContextMenuItem className={ITEM} onSelect={() => onLoop(section)}>
              Loop {sections[section]!.name}
            </ContextMenuItem>
            <ContextMenuSeparator className="my-1 h-px bg-line" />
          </>
        ) : null}
        <ContextMenuItem className={ITEM} disabled={!onOverview} onSelect={() => onOverview?.()}>
          Show whole track… <span className="ml-auto pl-6 text-[12px] text-white/40">roll / score</span>
        </ContextMenuItem>
        <ContextMenuSeparator className="my-1 h-px bg-line" />
        <ContextMenuItem className={ITEM} disabled={!soundChangeable || busy} onSelect={onChangeSound}>
          Change sound…
        </ContextMenuItem>
        <ContextMenuItem className={ITEM} disabled={!editable || busy} onSelect={onNewPattern}>
          New pattern
        </ContextMenuItem>
        <ContextMenuSeparator className="my-1 h-px bg-line" />
        <ContextMenuItem className={`${ITEM} text-err`} disabled={busy} onSelect={onRemove}>
          Remove track <span className="ml-auto pl-6 text-[12px] text-white/40">Undo: Ctrl+Z</span>
        </ContextMenuItem>
        <ContextMenuSeparator className="my-1 h-px bg-line" />
        <ContextMenuItem className={ITEM} disabled={busy} onSelect={() => onAdd(section)}>
          Add track…
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

interface SelectionActions {
  readonly label: string;
  readonly looping: boolean;
  onPlay(): void;
  onLoop(): void;
  onClear(): void;
}

function SelectionItems({ selection }: { selection: SelectionActions }) {
  return (
    <>
      <ContextMenuLabel className="px-3 pb-1 pt-2 font-mono text-[11px] font-normal text-sky-300/80">{selection.label}</ContextMenuLabel>
      <ContextMenuItem className={ITEM} onSelect={selection.onPlay}>
        Play from selection start
      </ContextMenuItem>
      {selection.looping ? null : (
        <ContextMenuItem className={ITEM} onSelect={selection.onLoop}>
          Loop selection <span className="ml-auto pl-6 text-[12px] text-white/40">L</span>
        </ContextMenuItem>
      )}
      <ContextMenuItem className={ITEM} onSelect={selection.onClear}>
        Clear selection
      </ContextMenuItem>
    </>
  );
}

/** Right-click menu for the ruler while a range is selected. */
function SelectionMenu({ selection, children }: { selection: SelectionActions | undefined; children: ReactNode }) {
  // Always the same tree, switched off without a selection: swapping the
  // wrapper in would remount the ruler mid-drag and break the drag.
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild disabled={!selection}>
        {children}
      </ContextMenuTrigger>
      {selection ? (
        <ContextMenuContent className={MENU}>
          <SelectionItems selection={selection} />
        </ContextMenuContent>
      ) : null}
    </ContextMenu>
  );
}

const CATALOG_ID = /^[0-9a-f]{16}$/u;
function catalogIdOf(id: unknown): string | undefined {
  return typeof id === 'string' && CATALOG_ID.test(id) ? id : undefined;
}

/** Track name, with the public name of its sound underneath when it is a catalog sound. */
/** Public sound name per track (tracks without a catalog sound, or still loading, are left out). */
function useSoundNames(tracks: readonly { name: string; catalogId: string | undefined }[]): Record<string, string> {
  const withIds = tracks.filter((t): t is { name: string; catalogId: string } => Boolean(t.catalogId));
  const results = useQueries({
    queries: withIds.map((t) => ({
      queryKey: soundsQueryKeys.item(t.catalogId),
      queryFn: ({ signal }: { signal: AbortSignal }) => soundsApi.get(t.catalogId, signal),
      staleTime: Infinity,
    })),
  });
  const out: Record<string, string> = {};
  withIds.forEach((t, i) => {
    const name = results[i]?.data?.name;
    if (name) out[t.name] = name;
  });
  return out;
}

/** Public name of a catalog sound (undefined while loading or for non-catalog sounds). */
function useSoundName(catalogId: string | undefined): string | undefined {
  const entry = useQuery({
    queryKey: soundsQueryKeys.item(catalogId ?? ''),
    queryFn: ({ signal }) => soundsApi.get(catalogId as string, signal),
    enabled: Boolean(catalogId),
    staleTime: Infinity,
  });
  return entry.data?.name;
}

function TrackName({ name, catalogId, notPlayed }: { name: string; catalogId: string | undefined; notPlayed: boolean }) {
  const sound = useSoundName(catalogId);
  return (
    <span className="flex min-w-0 flex-col leading-tight">
      <span className="truncate text-[13px] font-semibold text-white/90" title={name}>{name}</span>
      {notPlayed ? (
        <span className="truncate text-[11px] text-white/35" title="The playback engine has no voice for this track yet">
          Not in playback yet
        </span>
      ) : sound ? (
        <span className="truncate text-[11px] text-white/45" title={sound}>{sound}</span>
      ) : null}
    </span>
  );
}

/** Mute / solo for a track; applies live to the playing song. */
function MuteSolo({ lane, muted, solo, anySolo }: { lane: string; muted: boolean; solo: boolean; anySolo: boolean }) {
  const btn = 'h-6 w-6 rounded-[4px] border text-[11px] font-bold leading-none';
  return (
    <span className="ml-auto flex shrink-0 gap-1">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          livePlayer.setMuted(lane, !muted);
        }}
        aria-pressed={muted}
        aria-label={`${muted ? 'Unmute' : 'Mute'} ${lane}`}
        title={muted ? 'Unmute' : 'Mute'}
        className={`${btn} ${muted ? 'border-yellow-400 bg-yellow-400 text-black' : anySolo && !solo ? 'border-line text-white/30' : 'border-line text-white/60 hover:text-white'}`}
      >
        M
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          livePlayer.setSolo(lane, !solo);
        }}
        aria-pressed={solo}
        aria-label={`${solo ? 'Unsolo' : 'Solo'} ${lane}`}
        title={solo ? 'Unsolo' : 'Solo (hear only soloed tracks)'}
        className={`${btn} ${solo ? 'border-emerald-400 bg-emerald-400 text-black' : 'border-line text-white/60 hover:text-white'}`}
      >
        S
      </button>
    </span>
  );
}

function ToolButton({ onClick, label, children }: { onClick(): void; label: string; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="h-8 min-w-8 rounded-[6px] border border-line px-2 text-[14px] text-white/85 hover:border-white/50"
    >
      {children}
    </button>
  );
}

/** A remembered view preference (localStorage may be unavailable: then the default). */
function readPref(key: string, fallback: boolean): boolean {
  try {
    const v = window.localStorage.getItem(key);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}
function writePref(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // Not stored (private window, blocked storage): the choice lasts this visit.
  }
}
function readNumberPref(key: string, fallback: number): number {
  try {
    const v = Number(window.localStorage.getItem(key));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  } catch {
    return fallback;
  }
}
function writeNumberPref(key: string, value: number): void {
  try {
    window.localStorage.setItem(key, String(Math.round(value)));
  } catch {
    // Not stored (private window, blocked storage): the height lasts this visit.
  }
}

