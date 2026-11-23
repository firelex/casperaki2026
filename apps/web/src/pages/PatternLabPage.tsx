import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@teamsuzie/ui';
import { CommentList } from '../components/SuggestionComments';
import { downloadBytes, fileStem } from '../export/exportMidi';
import { mixExportStatus } from '../export/mixExportProgress';

import { songsQueryKeys } from '../api/songs';
import type { Genre } from '@casperaki/song-schema/schemas';

import { patternsApi, patternsQueryKey, type PatternProposal, type PreviewSection } from '../api/patterns';
import { livePlayer } from '../audio/livePlayer';
import { useLiveState } from '../audio/useLivePlayer';
import { BassGrid } from '../patterns/BassGrid';
import { ChordToneGrid } from '../patterns/ChordToneGrid';
import { DrumGrid } from '../patterns/DrumGrid';
import { GuitarGrid } from '../patterns/GuitarGrid';
import { GENRE_LABELS } from '../types/genres';

type Filter = 'pending' | 'approved' | 'rejected' | 'all';
type Family = PatternProposal['family'];

const FAMILY_LABELS: Record<Family, string> = {
  drums: 'Drums',
  bass: 'Bass',
  keys: 'Keys',
  pad: 'Pads',
  guitar: 'Guitar',
  synths: 'Synths',
  pluckedSynths: 'Plucked synths',
  popStrings: 'Strings',
  popBrass: 'Brass',
};
const DIFFERS: Record<Family, string> = {
  drums: 'the drums differ (and parts that follow them)',
  bass: 'the bass differs',
  keys: 'the keys differ',
  pad: 'the pads differ',
  guitar: 'the guitar differs',
  synths: 'the synths differ',
  pluckedSynths: 'the plucked synths differ',
  popStrings: 'the strings differ',
  popBrass: 'the brass differs',
};
const FAMILY_ORDER: readonly Family[] = ['drums', 'bass', 'keys', 'guitar', 'pad', 'popStrings', 'popBrass', 'synths', 'pluckedSynths'];

/**
 * Pattern lab (admins): review the patterns Casperaki suggests to fill thin
 * styles. Each proposal can be heard inside a full song in its genre, next
 * to the same song with the current library, then approved or rejected.
 * Approved patterns reach new songs once exported into the library
 * (apps/brain/scripts/export-approved-patterns.ts).
 */
/** Per preview song (by player key): the tracks of the proposal's instrument and the sections. */
const previewInfo = new Map<string, { lanes: string[]; sections: PreviewSection[] }>();

/** Where a verses / choruses pattern is heard: the first run of back-to-back verses (or choruses),
 *  e.g. verse1 + verse2, else the first run of sections of that energy. Undefined for a pattern
 *  every section plays. */
function focusRange(
  sections: readonly PreviewSection[],
  energy: 'low' | 'high' | undefined,
  solo: boolean,
  instrument: string,
): { start: number; end: number } | undefined {
  const typeOf = (x: PreviewSection) => x.name.replace(/\d+$/u, '');
  // Solo: only sections where the instrument plays (else solo is silence).
  if (solo && !sections.some((x) => x.plays)) {
    throw new Error(`The ${instrument.toLowerCase()} does not play anywhere in this preview song, so solo would be silent.`);
  }
  const usable = (x: PreviewSection) => !solo || x.plays;
  /** The run of back-to-back sections from index i that `match` (and are usable). */
  const runFrom = (i: number, match: (x: PreviewSection) => boolean) => {
    let j = i;
    while (j + 1 < sections.length && match(sections[j + 1]!) && usable(sections[j + 1]!)) j++;
    return { start: sections[i]!.start, end: sections[j]!.end };
  };
  if (energy) {
    const type = energy === 'low' ? 'verse' : 'chorus';
    let match = (x: PreviewSection) => typeOf(x) === type;
    if (!sections.some(match)) match = (x) => x.energy === energy;
    if (!sections.some(match)) throw new Error(`The preview song has no ${type} to play this pattern in.`);
    const own = sections.findIndex((x) => match(x) && usable(x));
    if (own >= 0) return runFrom(own, match);
    // Solo, and the instrument is silent in the pattern's own sections: the next sections where it plays.
    const first = sections.findIndex(match);
    const next = sections.findIndex((x, i) => i > first && x.plays);
    const at = next >= 0 ? next : sections.findIndex((x) => x.plays);
    return runFrom(at, (x) => typeOf(x) === typeOf(sections[at]!));
  }
  if (!solo) return undefined;
  // A pattern for any section, soloed: start where the instrument first plays, and loop that part.
  const at = sections.findIndex((x) => x.plays);
  return runFrom(at, (x) => typeOf(x) === typeOf(sections[at]!));
}

/**
 * The last thing asked to play (the player is shared by every card): which song and
 * whether soloed. A song loads once, by whichever request came first, so solo is
 * set from this latest request, not from the request that started the load.
 */
let latestListen: { n: number; key: string; solo: boolean } = { n: 0, key: '', solo: false };

/** Loop the sections the selected pattern belongs to (for solo: where the instrument plays), or
 *  play the whole song; returns where that part starts. */
function applyFocus(sections: readonly PreviewSection[], energy: 'low' | 'high' | undefined, solo: boolean, instrument: string): number {
  const r = focusRange(sections, energy, solo, instrument);
  if (!r) {
    livePlayer.setLoopRange(undefined);
    return 0;
  }
  livePlayer.setLoopRange(r);
  livePlayer.setLooping(true);
  return r.start;
}

/** The suggestions page's Patterns section (the pattern lab). */
export function PatternsSection() {
  // The player is shared with the editor: leave nothing soloed or looped behind.
  useEffect(
    () => () => {
      livePlayer.setSoloLanes([]);
      livePlayer.setLoopRange(undefined);
    },
    [],
  );
  const [filter, setFilter] = useState<Filter>('pending');
  const [family, setFamily] = useState<Family | 'all'>('all');
  const query = useQuery({ queryKey: patternsQueryKey, queryFn: ({ signal }) => patternsApi.list(signal) });
  const proposals = (query.data?.proposals ?? []).filter((p) => family === 'all' || p.family === family);
  const families = FAMILY_ORDER.filter((f) => (query.data?.proposals ?? []).some((p) => p.family === f));
  const count = (f: Filter) => proposals.filter((p) => matches(p, f)).length;
  const shown = proposals.filter((p) => matches(p, filter));

  return (
    <>
        <p className="mt-6 max-w-[70ch] text-[15px] leading-relaxed text-white/60">
          Patterns Casperaki suggests for styles the library covers thinly. Listen to each one in a full song, compare
          it with the same song using today&rsquo;s patterns, then approve or reject it. Approved patterns join the
          library at the next export.
        </p>

        <div className="mt-8 flex flex-wrap gap-2" role="tablist" aria-label="Filter proposals">
          {(['pending', 'approved', 'rejected', 'all'] as const).map((f) => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={filter === f}
              onClick={() => setFilter(f)}
              className={`h-9 rounded-full border px-4 text-[14px] ${
                filter === f ? 'border-white bg-white text-black' : 'border-line text-white/75 hover:border-white/50'
              }`}
            >
              {f === 'pending' ? 'To review' : f[0]!.toUpperCase() + f.slice(1)} ({count(f)})
            </button>
          ))}
        </div>

        {families.length > 1 ? (
          <div className="mt-3 flex flex-wrap gap-2" role="tablist" aria-label="Filter by instrument">
            {(['all', ...families] as const).map((f) => (
              <button
                key={f}
                type="button"
                role="tab"
                aria-selected={family === f}
                onClick={() => setFamily(f)}
                className={`h-8 rounded-full px-3 text-[13px] ${family === f ? 'bg-white/15 text-white' : 'text-white/55 hover:text-white'}`}
              >
                {f === 'all' ? 'All instruments' : FAMILY_LABELS[f]}
              </button>
            ))}
          </div>
        ) : null}

        <div className="mt-8 flex flex-col gap-6">
          {query.isLoading ? (
            <p className="text-white/55">Loading proposals…</p>
          ) : query.isError ? (
            <p className="text-err">Proposals could not be loaded: {query.error.message}</p>
          ) : shown.length === 0 ? (
            <p className="text-white/55">{filter === 'pending' ? 'Nothing left to review.' : 'No proposals here.'}</p>
          ) : (
            shown.map((p) => <ProposalCard key={p.id} proposal={p} />)
          )}
        </div>
    </>
  );
}

function matches(p: PatternProposal, f: Filter): boolean {
  if (f === 'all') return true;
  if (f === 'pending') return p.review === null;
  return p.review?.status === f;
}

function ProposalCard({ proposal: p }: { proposal: PatternProposal }) {
  const queryClient = useQueryClient();
  const [genre, setGenre] = useState<Genre>(p.genres[0]!);
  const [take, setTake] = useState(0);
  /** The instrument picker: a library sound for the proposal's instrument (undefined: the song's own). */
  const [sound, setSound] = useState<string | undefined>(undefined);
  const sounds = useQuery({
    queryKey: ['patterns', p.id, 'sounds', genre],
    queryFn: ({ signal }) => patternsApi.sounds(p.id, genre, signal),
    enabled: p.family !== 'drums',
    staleTime: Infinity,
  });
  const [note, setNote] = useState(p.review?.note ?? '');
  const live = useLiveState();
  const comment = useMutation({
    mutationFn: () => patternsApi.comment(p.id, note.trim()),
    onSuccess: () => {
      setNote('');
      void queryClient.invalidateQueries({ queryKey: patternsQueryKey });
    },
  });
  const review = useMutation({
    mutationFn: (status: 'approved' | 'rejected' | 'pending') => patternsApi.review(p.id, status, note),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: patternsQueryKey }),
  });

  // "Play in context" and "Play solo" play the same proposal song (one load); solo
  // solos the tracks of the proposal's instrument, which the preview names.
  type Mode = 'context' | 'solo' | 'current';
  const [mode, setMode] = useState<Mode>('context');
  /** Why the last Play did not play (e.g. solo where the instrument is silent). */
  const [listenError, setListenError] = useState<string | undefined>(undefined);
  // The proposal song plays only the selected pattern (a generator has just the one).
  const takeArg = (t: number) => (p.kind === 'algo' ? undefined : t);
  const keyFor = (variant: 'proposal' | 'current', t: number = take, snd: string | undefined = sound, g: Genre = genre) =>
    variant === 'proposal'
      ? `pattern:${p.id}:${g}:proposal:${takeArg(t) ?? 'all'}:${snd ?? 'own'}`
      : `pattern:${p.id}:${g}:current:${snd ?? 'own'}`;
  const keyOf = (m: Mode, t: number = take, snd: string | undefined = sound, g: Genre = genre) => keyFor(m === 'current' ? 'current' : 'proposal', t, snd, g);
  /** The preview song's loader for these settings (it remembers the song's tracks and sections). */
  const loaderFor = (m: Mode, t: number, snd: string | undefined, g: Genre) => async (signal: AbortSignal) => {
    const payload = await patternsApi.preview(p.id, g, m === 'current' ? 'current' : 'proposal', m === 'current' ? undefined : takeArg(t), snd, signal);
    if (payload.lanes.length === 0) throw new Error(`The preview song has no ${FAMILY_LABELS[p.family]} track to solo.`);
    previewInfo.set(keyOf(m, t, snd, g), { lanes: payload.lanes, sections: payload.sections });
    return payload;
  };
  /** `swap`: switching pattern or sound while this card plays: the current version keeps playing
   *  while the new one loads, then they swap (a pattern switch then jumps to its sections). */
  const listen = (m: Mode, t: number = take, snd: string | undefined = sound, g: Genre = genre, swap = false) => {
    const key = keyOf(m, t, snd, g);
    if (live.key === key && live.status === 'playing' && mode === m && t === take && snd === sound && g === genre) {
      void livePlayer.pause();
      return;
    }
    setMode(m);
    const request = { n: latestListen.n + 1, key, solo: m === 'solo' };
    latestListen = request;
    const energy = energyOf(p, t);
    const instrument = FAMILY_LABELS[p.family];
    const info = previewInfo.get(key);
    setListenError(undefined);
    if (info) {
      let start: number;
      try {
        start = applyFocus(info.sections, energy, m === 'solo', instrument);
      } catch (err) {
        // E.g. solo where the instrument plays nowhere: say so instead of playing silence.
        setListenError(err instanceof Error ? err.message : String(err));
        void livePlayer.pause();
        return;
      }
      livePlayer.setSoloLanes(m === 'solo' ? info.lanes : []);
      // Solo always starts from the beginning (of the part it loops, or of the song); so does a
      // switch to another pattern's sections. (A song not loaded yet starts there anyway.)
      if (live.key === key && (m === 'solo' || t !== take)) livePlayer.seek(start);
    } else if (!swap) livePlayer.setSoloLanes([]);
    const load = loaderFor(m, t, snd, g);
    const playing = livePlayer.play(key, async (signal) => {
      const payload = await load(signal);
      // Solo as the LATEST request for this song asks (it may be a Play solo pressed while this loaded).
      const solo = latestListen.key === key ? latestListen.solo : m === 'solo';
      // Throws for a solo where the instrument plays nowhere: the player shows that message.
      applyFocus(payload.sections, energy, solo, instrument);
      if (latestListen.key === key) livePlayer.setSoloLanes(solo ? payload.lanes : []);
      return payload;
    }, swap ? { seamless: true } : {});
    // A song already loading for an earlier request does not run this request's loader: set solo once it plays.
    void playing.then(() => {
      if (latestListen.n !== request.n) return;
      const loaded = previewInfo.get(key);
      if (!loaded) return;
      let start: number;
      try {
        start = applyFocus(loaded.sections, energy, request.solo, instrument);
      } catch (err) {
        setListenError(err instanceof Error ? err.message : String(err));
        void livePlayer.pause();
        return;
      }
      livePlayer.setSoloLanes(request.solo ? loaded.lanes : []);
      // A swapped-in pattern plays in its own sections (a swapped-in sound stays where it was).
      if (swap && t !== take) livePlayer.seek(start);
    });
  };
  // Choosing another pattern while this card plays switches to it (and to its section).
  const selectTake = (t: number) => {
    const playingHere = live.key === keyOf(mode) && live.status === 'playing';
    setTake(t);
    if (playingHere && t !== take) listen(mode, t, sound, genre, true);
  };
  // Another sound while this card plays: the same part again with it.
  const selectSound = (snd: string | undefined) => {
    const playingHere = live.key === keyOf(mode) && live.status === 'playing';
    setSound(snd);
    if (playingHere && snd !== sound) listen(mode, take, snd, genre, true);
  };
  // Another style while this card plays: that style's song, in the same mode and at the pattern's section.
  const selectGenre = (g: Genre) => {
    const playingHere = live.key === keyOf(mode) && (live.status === 'playing' || live.status === 'loading');
    setGenre(g);
    setSound(undefined); // the sounds on offer depend on the genre
    if (playingHere && g !== genre) listen(mode, take, undefined, g);
  };
  // Download MP3: the song as last heard on this card (proposal or current, in context or solo), rendered in the
  // browser; mastered like playback, but a solo unmastered (mastering one instrument alone would push it up).
  const [download, setDownload] = useState<{ status: string } | { error: string } | undefined>(undefined);
  const downloadMp3 = async () => {
    const key = keyOf(mode);
    const load = loaderFor(mode, take, sound, genre);
    setDownload({ status: 'Preparing the song…' });
    try {
      let soloLanes: string[] | undefined;
      if (mode === 'solo') {
        if (!previewInfo.has(key)) await livePlayer.payloadOf(key, load);
        const info = previewInfo.get(key);
        if (!info) throw new Error('The preview song did not say which tracks to solo.');
        soloLanes = info.lanes;
      }
      const files = await livePlayer.mixExport(key, load, (pr) => setDownload({ status: `Making the MP3: ${mixExportStatus(pr).label}` }), soloLanes);
      const what = mode === 'current' ? 'current library' : `pattern ${take + 1}${mode === 'solo' ? ', solo' : ''}`;
      downloadBytes(mode === 'solo' ? files.unmasteredMp3 : files.masteredMp3, `${fileStem(`${p.name} - ${GENRE_LABELS[genre]} (${what})`)}.mp3`, 'audio/mpeg');
      setDownload(undefined);
    } catch (err) {
      setDownload({ error: err instanceof Error ? err.message : String(err) });
    }
  };
  // Open in editor: the song as heard (the mode last played: the proposal, or the current library) as a new project.
  const navigate = useNavigate();
  const openInEditor = useMutation({
    mutationFn: () => patternsApi.project(p.id, genre, mode === 'current' ? 'current' : 'proposal', mode === 'current' ? undefined : takeArg(take), sound),
    onSuccess: ({ id }) => {
      void queryClient.invalidateQueries({ queryKey: songsQueryKeys.list });
      navigate(`/editor/${id}/timeline`);
    },
  });
  const stateOf = (m: Mode) => (live.key === keyOf(m) && mode === m ? live.status : 'idle');
  const status = p.review?.status;

  return (
    <article className="rounded-[14px] border border-line/60 bg-panel p-5 sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-[20px] font-semibold text-white">{p.name}</h2>
          <p className="mt-1 text-[14px] text-white/55">
            {FAMILY_LABELS[p.family]} ·{' '}
            {p.kind === 'algo' ? 'generator (new variations every song)' : `${takes(p)} fixed patterns`} ·{' '}
            {p.genres.map((g) => GENRE_LABELS[g]).join(', ')}
          </p>
        </div>
        <StatusBadge status={status} inLibrary={p.inLibrary} />
      </div>

      <p className="mt-4 max-w-[80ch] text-[15px] leading-relaxed text-white/75">{p.rationale}</p>

      {p.kind !== 'algo' ? (
        <div className="mt-5">
          {takes(p) > 1 ? (
            <div className="mb-3 flex gap-2">
              {Array.from({ length: takes(p) }, (_, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => selectTake(i)}
                  className={`h-8 rounded-full px-3 text-[13px] ${take === i ? 'bg-white/15 text-white' : 'text-white/55 hover:text-white'}`}
                >
                  Pattern {i + 1}
                  {energyOf(p, i) ? <span className="ml-1 text-white/40">({energyOf(p, i) === 'low' ? 'verses' : 'choruses'})</span> : null}
                </button>
              ))}
            </div>
          ) : null}
          {p.kind === 'bassPatterns' ? (
            <BassGrid pattern={p.patterns[take]!} />
          ) : p.kind === 'chordTones' ? (
            <ChordToneGrid pattern={p.patterns[take]!} />
          ) : p.kind === 'guitarPicks' ? (
            <GuitarGrid pattern={p.patterns[take]!} />
          ) : (
            <DrumGrid blueprint={p.blueprints[take]!} />
          )}
          <p className="mt-2 text-[12px] text-white/40">
            {p.kind === 'bassPatterns'
              ? 'Two bars; each note is an interval from the current chord root, so the line follows the chords. A song picks among these patterns section by section.'
              : p.kind === 'chordTones'
                ? 'Shown as it sounds over a C major chord. Over every other chord each note moves to the nearest chord tone, so the voicing keeps its shape and moves as little as possible. Verses and choruses can each take their own pattern.'
                : p.kind === 'guitarPicks'
                  ? 'Strings of the chord shape, counted from its bass note: one string is a picked note, several are a strum in the order shown. Verses and choruses can each take their own pattern.'
                  : 'Two bars, 32nd-note steps. A song picks among these patterns section by section.'}
          </p>
        </div>
      ) : (
        <p className="mt-5 text-[14px] text-white/50">Generated fresh for every song and section: listen to hear it.</p>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-3">
        {p.genres.length > 1 ? (
          <select
            value={genre}
            onChange={(e) => selectGenre(e.target.value as Genre)}
            aria-label="Genre for the preview song"
            className="h-10 rounded-[8px] border border-line bg-bg px-3 text-[14px] text-white"
          >
            {p.genres.map((g) => (
              <option key={g} value={g}>
                {GENRE_LABELS[g]}
              </option>
            ))}
          </select>
        ) : null}
        {p.family !== 'drums' ? (
          <select
            value={sound ?? ''}
            onChange={(e) => selectSound(e.target.value || undefined)}
            disabled={!sounds.data}
            aria-label={`${FAMILY_LABELS[p.family]} sound for the preview`}
            title="Hear the pattern with another sound of this instrument"
            className="h-10 max-w-[260px] rounded-[8px] border border-line bg-bg px-3 text-[14px] text-white"
          >
            <option value="">{sounds.isError ? 'Sounds could not be loaded' : `The song's own ${FAMILY_LABELS[p.family].toLowerCase()} sound`}</option>
            {([true, false] as const).map((inStyle) => {
              const list = (sounds.data?.sounds ?? []).filter((s) => s.inStyle === inStyle);
              return list.length ? (
                <optgroup key={String(inStyle)} label={inStyle ? `Used in ${GENRE_LABELS[genre]} songs` : `Other ${FAMILY_LABELS[p.family].toLowerCase()} sounds`}>
                  {list.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </optgroup>
              ) : null;
            })}
          </select>
        ) : null}
        <ListenButton state={stateOf('context')} onClick={() => listen('context')} label="Play in context" primary />
        <ListenButton state={stateOf('solo')} onClick={() => listen('solo')} label="Play solo" primary />
        <ListenButton state={stateOf('current')} onClick={() => listen('current')} label="Current library" />
        <DropdownMenu>
          <DropdownMenuTrigger
            className="flex h-10 w-10 items-center justify-center rounded-full border border-line text-[18px] leading-none text-white/80 outline-none hover:border-white/60 hover:text-white focus-visible:ring-2 focus-visible:ring-white/60"
            aria-label="More: open in editor, download MP3"
            title="Open in editor, download MP3"
          >
            ⋯
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" sideOffset={6} className="z-50 min-w-[240px] rounded-[10px] border border-line bg-panel p-1 text-white shadow-2xl">
            <DropdownMenuItem
              className="cursor-pointer rounded-[6px] px-3 py-2 text-[14px] outline-none data-[highlighted]:bg-white/10"
              disabled={openInEditor.isPending}
              onSelect={() => openInEditor.mutate()}
            >
              Open in editor
              <div className="text-[11px] text-white/45">This song as a new song of yours</div>
            </DropdownMenuItem>
            <DropdownMenuItem
              className="cursor-pointer rounded-[6px] px-3 py-2 text-[14px] outline-none data-[highlighted]:bg-white/10"
              disabled={download !== undefined && 'status' in download}
              onSelect={() => void downloadMp3()}
            >
              Download MP3
              <div className="text-[11px] text-white/45">
                {mode === 'current' ? 'The current library' : mode === 'solo' ? 'This pattern, solo' : 'This pattern in context'} · {GENRE_LABELS[genre]}
              </div>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {openInEditor.isPending ? <span className="text-[13px] text-white/55">Opening…</span> : null}
        {openInEditor.isError ? <span className="text-[13px] text-err">Not opened: {openInEditor.error.message}</span> : null}
        {download && 'status' in download ? <span className="text-[13px] text-white/55">{download.status}</span> : null}
        {download && 'error' in download ? <span className="text-[13px] text-err">No MP3: {download.error}</span> : null}
        {listenError ? <span className="text-[13px] text-err">{listenError}</span> : null}
        {live.key === keyOf(mode) && live.status === 'loading' ? (
          <span className="text-[13px] text-white/55">{live.step}</span>
        ) : live.key === keyOf(mode) && live.status === 'error' ? (
          <span className="text-[13px] text-err">{live.error}</span>
        ) : null}
      </div>
      <p className="mt-2 text-[12px] text-white/40">
        In context and the current library play the same {GENRE_LABELS[genre]} song; only{' '}
        {DIFFERS[p.family]}. Solo plays just the {FAMILY_LABELS[p.family].toLowerCase()} of the in-context song.
        {energyOf(p, take) ? ` This pattern is for ${energyOf(p, take) === 'low' ? 'verses' : 'choruses'}: playing loops the first ${energyOf(p, take) === 'low' ? 'verses' : 'choruses'} (back-to-back ones together).` : ''}
      </p>

      {p.comments.length ? (
        <div className="mt-6 border-t border-line/60 pt-5">
          <div className="mb-2 text-[13px] text-white/60">Comments</div>
          <CommentList comments={p.comments} />
        </div>
      ) : null}

      <div className={`${p.comments.length ? 'mt-4' : 'mt-6 border-t border-line/60 pt-5'} flex flex-col gap-3 sm:flex-row sm:items-end`}>
        <label className="flex flex-1 flex-col gap-2">
          <span className="text-[13px] text-white/60">Note or comment</span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            maxLength={2000}
            placeholder="What works, what doesn't. Approve or Reject saves it with the decision; Comment adds it below."
            className="rounded-[8px] border border-line bg-bg px-3 py-2 text-[14px] text-white outline-none focus:border-white/50"
          />
        </label>
        <div className="flex gap-2">
          {status ? (
            <button type="button" onClick={() => review.mutate('pending')} disabled={review.isPending} className="h-10 rounded-full px-4 text-[14px] text-white/70 hover:text-white">
              Undo
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => comment.mutate()}
            disabled={comment.isPending || !note.trim()}
            title="Save the text as a comment, without approving or rejecting"
            className="h-10 rounded-full border border-line px-5 text-[14px] font-semibold text-white hover:border-white/60 disabled:opacity-40"
          >
            {comment.isPending ? 'Saving…' : 'Comment'}
          </button>
          <button
            type="button"
            onClick={() => review.mutate('rejected')}
            disabled={review.isPending}
            className="h-10 rounded-full border border-line px-5 text-[14px] font-semibold text-white hover:border-white/60"
          >
            Reject
          </button>
          <button
            type="button"
            onClick={() => review.mutate('approved')}
            disabled={review.isPending}
            className="h-10 rounded-full bg-accent px-5 text-[14px] font-semibold text-white hover:bg-[#e00000]"
          >
            Approve
          </button>
        </div>
      </div>
      {review.isError ? <p className="mt-2 text-[13px] text-err">The decision was not saved: {review.error.message}</p> : null}
      {comment.isError ? <p className="mt-2 text-[13px] text-err">The comment was not saved: {comment.error.message}</p> : null}
      {p.review ? (
        <p className="mt-3 text-[12px] text-white/40">
          {p.review.status === 'approved' ? 'Approved' : 'Rejected'} by {p.review.reviewer} on{' '}
          {new Date(p.review.decidedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
        </p>
      ) : null}
    </article>
  );
}

function takes(p: PatternProposal): number {
  return p.kind === 'algo' ? 0 : p.kind === 'blueprints' ? p.blueprints.length : p.patterns.length;
}

function energyOf(p: PatternProposal, i: number): 'low' | 'high' | undefined {
  return p.kind === 'chordTones' || p.kind === 'guitarPicks' ? p.patterns[i]?.energy : undefined;
}

function ListenButton({ state, onClick, label, primary }: { state: string; onClick(): void; label: string; primary?: boolean }) {
  const playing = state === 'playing';
  const loading = state === 'loading';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading}
      className={`inline-flex h-10 items-center gap-2 rounded-full px-4 text-[14px] font-semibold disabled:opacity-70 ${
        primary ? 'bg-white text-black hover:bg-white/85' : 'border border-white/30 text-white hover:border-white/60'
      }`}
    >
      <span aria-hidden="true">{loading ? '…' : playing ? '❚❚' : '▶'}</span>
      {label}
    </button>
  );
}

function StatusBadge({ status, inLibrary }: { status: 'approved' | 'rejected' | undefined; inLibrary: boolean }) {
  const [text, tone] =
    status === 'approved'
      ? inLibrary
        ? ['In the library', 'border-ok/50 text-ok']
        : ['Approved, waiting for export', 'border-ok/50 text-ok']
      : status === 'rejected'
        ? inLibrary
          ? ['Rejected, still in library until export', 'border-err/50 text-err']
          : ['Rejected', 'border-err/50 text-err']
        : ['To review', 'border-line text-white/70'];
  return <span className={`rounded-full border px-3 py-1 text-[12px] ${tone}`}>{text}</span>;
}
