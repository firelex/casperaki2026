import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueries, useQuery, type UseQueryResult } from '@tanstack/react-query';

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@teamsuzie/ui';
import { soundsApi, soundsQueryKeys, type SoundFamily, type SoundItem } from '../api/sounds';
import { useLiveTransport } from '../audio/useLiveTransport';
import { useSession } from '../state/session';
import { indexInstrumentDefinitions } from '../types/song';
import { buildSequencerModel } from './sequencerModel';
import { useTrackEdits } from './sequencer/useTrackEdits';
import { tracksApi, type DrumKitRow, type TransitionPlacement } from '../api/tracks';
import { pluralKind } from './sequencer/TransitionsWindow';
import { SoundBrowser } from './sounds/SoundBrowser';

const GROUPS = ['Instruments', 'Drum hits', 'Loops & breaks', 'FX'] as const;
const CATALOG_ID = /^[0-9a-f]{16}$/u;

/**
 * The sound library (Sounds tab), as a DAW's sound browser: every sound by
 * family, searchable and filterable by style. Click a sound to hear it: a
 * tonal sound plays a short pattern written for it, a drum hit a groove of
 * its kind, a loop loops, an effect plays once. "Use on <track>" puts it on
 * a track of this song (as Change sound does). Public names only.
 */
export function SoundsView() {
  const { viewSong } = useSession();
  const { liveKey } = useLiveTransport();
  const edits = useTrackEdits(liveKey);
  const families = useQuery({ queryKey: soundsQueryKeys.families, queryFn: ({ signal }) => soundsApi.families(signal), staleTime: Infinity });
  const [family, setFamily] = useState<string>('keys');
  const [highlight, setHighlight] = useState<string | undefined>(undefined);
  const famInfo = families.data?.families.find((f) => f.id === family);
  // A transition type is shown as family "transition:<type>".
  const transitionType = family.startsWith('transition:') ? family.slice('transition:'.length) : undefined;
  const transitionInfo = transitionType ? families.data?.transitions.find((t) => t.type === transitionType) : undefined;

  // The song's tracks and their sounds.
  const model = useMemo(() => (viewSong ? buildSequencerModel(viewSong) : undefined), [viewSong]);
  const defs = useMemo(() => indexInstrumentDefinitions(viewSong), [viewSong]);
  const songTracks = (model?.tracks ?? []).map((t) => {
    const id = defs.get(t.name)?.id;
    return { name: t.name, color: t.color, soundId: typeof id === 'string' && CATALOG_ID.test(id) ? id : undefined };
  });
  const songSounds = useQueries({
    queries: songTracks.map((t) => ({
      queryKey: soundsQueryKeys.item(t.soundId ?? ''),
      queryFn: ({ signal }: { signal: AbortSignal }) => soundsApi.get(t.soundId!, signal),
      enabled: Boolean(t.soundId),
      staleTime: Infinity,
    })),
  });

  // Where a sound can go in this song: replace the sound of a track of its
  // kind (the one whose current sound is of the same type first), or a new track.
  const soundOfTrack = new Map(songTracks.map((t, i) => [t.name, songSounds[i]?.data]));
  const sections = model?.sections.map((x) => x.name) ?? [];
  // The song's drum kit (for drum hits: which drum they can replace).
  const hasDrums = Boolean(viewSong?.instrumentDefinitions.some((d) => d.name === 'Drums'));
  const drumKit = useQuery({
    queryKey: ['drum-kit', viewSong?.genre, JSON.stringify(viewSong?.instrumentDefinitions.find((d) => d.name === 'Drums') ?? null)],
    queryFn: ({ signal }) => {
      if (!viewSong) throw new Error('No song is open.');
      return tracksApi.drumKit(viewSong, signal);
    },
    enabled: Boolean(viewSong && hasDrums),
    staleTime: Infinity,
  });
  // The song's transitions (for transition sounds: where they can go).
  const transitionState = useQuery({
    queryKey: ['transition-state', JSON.stringify(viewSong ? Object.fromEntries(Object.entries(viewSong.arrangement).map(([k, v]) => [k, v.transitions ?? {}])) : null), sections.join(',')],
    queryFn: ({ signal }) => {
      if (!viewSong) throw new Error('No song is open.');
      return tracksApi.transitionState(viewSong, signal);
    },
    enabled: Boolean(viewSong && transitionType),
    staleTime: Infinity,
  });
  const useOptions = (s: SoundItem): UseOption[] => {
    if (transitionType) {
      const state = transitionState.data;
      if (!state) return [];
      const label = transitionInfo?.label ?? transitionType;
      // Sections that have this transition, by kind (all choruses, …), then everywhere.
      const having = (model?.sections ?? []).filter((x) => state.sections[x.name]?.some((t) => t.type === transitionType));
      const kinds = [...new Set(having.map((x) => x.kind))];
      const opts: UseOption[] = kinds.map((k) => {
        const segs = having.filter((x) => x.kind === k).map((x) => x.name);
        return { kind: 'transition' as const, label, segments: segs, where: segs.length === 1 ? `in ${segs[0]!}` : `in all ${pluralKind(k)} (${segs.length})` };
      });
      if (kinds.length > 1) opts.push({ kind: 'transition', label, segments: having.map((x) => x.name), where: `everywhere (${having.length} sections)` });
      return opts;
    }
    if (s.drumRoles.length > 0) {
      const rows = (drumKit.data?.kit ?? []).filter((r) => s.drumRoles.includes(r.role) && r.soundId !== s.id);
      return rows.map((row, i) => ({ kind: 'drum' as const, row, suggested: i === 0 }));
    }
    const opts = edits.options.data;
    if (!opts || !s.useAs) return [];
    const replace = Object.entries(opts.tracks)
      .filter(([, t]) => t.family === s.useAs && t.editable && t.soundId !== s.id)
      .map(([track]) => {
        const current = soundOfTrack.get(track);
        return { kind: 'replace' as const, track, current: current?.name, suggested: current?.type === s.type };
      })
      .sort((a, b) => Number(b.suggested) - Number(a.suggested));
    if (replace.length > 0 && !replace.some((r) => r.suggested)) replace[0] = { ...replace[0]!, suggested: true };
    const fam = opts.families.find((f) => f.family === s.useAs);
    const add = fam && sections.length ? [{ kind: 'add' as const, family: s.useAs, label: fam.label }] : [];
    return [...replace, ...add];
  };
  const useSound = (s: SoundItem, o: UseOption) =>
    o.kind === 'transition'
      ? void edits.runSongEdit(`Putting ${s.name} in as the ${o.label.toLowerCase()}`, async (song) => {
          // One call per placement (a reverse can sit at the start in one section and the end in another).
          const state = transitionState.data;
          if (!state || !transitionType) throw new Error('The song’s transitions are not loaded.');
          const byPlacement = new Map<TransitionPlacement, string[]>();
          for (const seg of o.segments) {
            const t = state.sections[seg]?.find((x) => x.type === transitionType);
            if (!t) throw new Error(`${seg} has no ${o.label.toLowerCase()}.`);
            byPlacement.set(t.placement, [...(byPlacement.get(t.placement) ?? []), seg]);
          }
          let out = song;
          for (const [placement, segments] of byPlacement) {
            out = (await tracksApi.setTransition(out, { segments, type: transitionType, placement, on: true, soundId: s.id })).song;
          }
          return out;
        })
      : o.kind === 'drum'
      ? void edits.run({ kind: 'setDrumSound', role: o.row.role, soundId: s.id }, `Putting ${s.name} in as ${o.row.label.toLowerCase()}`)
      : o.kind === 'replace'
      ? void edits.run({ kind: 'changeSound', track: o.track, soundId: s.id }, `Putting ${s.name} on ${o.track}`)
      : void edits.run({ kind: 'addTrack', family: o.family, segments: sections, soundId: s.id }, `Adding a ${o.label.toLowerCase()} track with ${s.name}`);

  return (
    <div className="flex h-full min-h-0 bg-[#1b1c1f] text-white">
      <SoundFamiliesNav families={families} family={family} onFamily={setFamily}>
          {songTracks.length ? (
            <div className="mt-2 border-t border-black/50 pt-3">
              <div className="px-2 pb-1 text-[10px] font-semibold text-[#8f9098]">IN THIS SONG</div>
              {songTracks.map((t, i) => {
                const s = songSounds[i]?.data;
                return (
                  <button
                    key={t.name}
                    type="button"
                    disabled={!s}
                    onClick={() => {
                      if (!s) return;
                      setFamily(s.family);
                      setHighlight(s.id);
                    }}
                    className="flex w-full items-center gap-2 rounded-[6px] px-2 py-1.5 text-left hover:bg-white/6 disabled:opacity-50"
                    title={s ? `Show ${s.familyLabel.toLowerCase()}` : 'Not a library sound'}
                  >
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: t.color }} aria-hidden="true" />
                    <span className="flex min-w-0 flex-col leading-tight">
                      <span className="truncate text-[12px] text-white/90">{t.name}</span>
                      <span className="truncate text-[11px] text-white/45">{s?.name ?? '—'}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}
      </SoundFamiliesNav>

      <SoundBrowser
        source={transitionType ? { transition: transitionType } : { family }}
        title={transitionInfo?.label ?? famInfo?.label ?? 'Sounds'}
        usage={(s) => [
          ...songTracks.filter((t) => t.soundId === s.id).map((t) => `${t.name} track`),
          ...(drumKit.data?.kit ?? []).filter((r) => r.soundId === s.id).map((r) => `${r.label} in the kit`),
          ...Object.entries(transitionState.data?.sections ?? {})
            .filter(([, ts]) => ts.some((t) => t.soundId === s.id))
            .map(([seg]) => `transition in ${seg}`),
        ]}
        actionLabel="Use"
        highlight={highlight}
        action={(s) => <UseMenu s={s} useOptions={useOptions(s)} onUse={(o) => useSound(s, o)} />}
        status={
          edits.busy ? (
            <span className="text-white/60" role="status">{edits.busy}…</span>
          ) : edits.error ? (
            <span className="text-err" role="alert">{edits.error}</span>
          ) : null
        }
      />
    </div>
  );
}

export type SoundFamilies = Awaited<ReturnType<typeof soundsApi.families>>;

/** The library's sidebar: sound families by group, then the transition types; `children` below them. */
export function SoundFamiliesNav({
  families,
  family,
  onFamily,
  children,
}: {
  families: UseQueryResult<SoundFamilies>;
  family: string;
  onFamily(id: string): void;
  children?: ReactNode;
}) {
  return (
    <aside className="flex w-[260px] shrink-0 flex-col border-r border-black/70 bg-[#202124]">
      <nav className="min-h-0 flex-1 overflow-y-auto p-2" aria-label="Sound families">
        {families.isError ? <p className="p-2 text-[12px] text-err">{families.error.message}</p> : null}
        {GROUPS.map((g) => {
          const fams = (families.data?.families ?? []).filter((f) => f.group === g);
          if (fams.length === 0) return null;
          return (
            <div key={g} className="mb-3">
              <div className="px-2 pb-1 text-[10px] font-semibold text-[#8f9098]">{g.toUpperCase()}</div>
              {fams.map((f) => (
                <FamilyButton key={f.id} f={f} active={f.id === family} onClick={() => onFamily(f.id)} />
              ))}
            </div>
          );
        })}
        {families.data?.transitions.length ? (
          <div className="mb-3">
            <div className="px-2 pb-1 text-[10px] font-semibold text-[#8f9098]">TRANSITIONS</div>
            {families.data.transitions.map((t) => (
              <FamilyButton
                key={t.type}
                f={{ id: `transition:${t.type}`, label: t.label, group: 'FX', count: t.count }}
                active={family === `transition:${t.type}`}
                onClick={() => onFamily(`transition:${t.type}`)}
              />
            ))}
          </div>
        ) : null}
        {children}
      </nav>
    </aside>
  );
}

function FamilyButton({ f, active, onClick }: { f: SoundFamily; active: boolean; onClick(): void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
      className={`flex w-full items-center justify-between rounded-[6px] px-2 py-1.5 text-left text-[13px] ${active ? 'bg-[#3a3c43] text-white' : 'text-white/75 hover:bg-white/6 hover:text-white'}`}
    >
      <span className="truncate">{f.label}</span>
      <span className="ml-2 font-mono text-[11px] text-white/40">{f.count.toLocaleString('en-GB')}</span>
    </button>
  );
}

type UseOption =
  | { kind: 'replace'; track: string; current: string | undefined; suggested: boolean }
  | { kind: 'add'; family: NonNullable<SoundItem['useAs']>; label: string }
  | { kind: 'drum'; row: DrumKitRow; suggested: boolean }
  | { kind: 'transition'; label: string; segments: string[]; where: string };

/** Use ▾: put the sound on a track of this song (suggested first) or a new track. */
function UseMenu({ s, useOptions, onUse }: { s: SoundItem; useOptions: UseOption[]; onUse(o: UseOption): void }) {
  return (
  <div className="flex justify-end">
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={useOptions.length === 0}>
        <button
          type="button"
          className="h-7 rounded-full border border-white/25 px-3 text-[12px] text-white hover:border-white/60 disabled:opacity-30"
          title={
            useOptions.length
              ? `Use ${s.name} in this song`
              : s.drumRoles.length
                ? 'This song has no drum kit'
                : s.useAs
                ? 'This song has no track of this kind, and its style writes none'
                : 'Sounds of this kind cannot go on a track yet'
          }
        >
          Use ▾
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="z-50 min-w-[260px] rounded-[10px] border border-line bg-panel p-1 text-white shadow-2xl">
        <DropdownMenuLabel className="px-3 py-2 text-[12px] font-normal text-white/50">Use {s.name} in this song</DropdownMenuLabel>
        {useOptions.map((o) => (
          <DropdownMenuItem
            key={o.kind === 'replace' ? o.track : o.kind === 'drum' ? o.row.role : o.kind === 'transition' ? o.where : 'add'}
            onSelect={() => onUse(o)}
            className="flex cursor-pointer items-center gap-2 rounded-[6px] px-3 py-2 text-[13px] outline-none data-[highlighted]:bg-white/10"
          >
            {o.kind === 'replace' ? (
              <>
                <span className="flex min-w-0 flex-col leading-tight">
                  <span>Replace on {o.track}</span>
                  <span className="truncate text-[11px] text-white/45">instead of {o.current ?? 'its current sound'}</span>
                </span>
                {o.suggested ? <span className="ml-auto rounded-full bg-emerald-400/15 px-2 py-0.5 text-[10px] text-emerald-300">Suggested</span> : null}
              </>
            ) : o.kind === 'transition' ? (
              <span>
                Use for the {o.label.toLowerCase()} {o.where}
              </span>
            ) : o.kind === 'drum' ? (
              <>
                <span className="flex min-w-0 flex-col leading-tight">
                  <span>Replace the {o.row.label.toLowerCase()} in the kit</span>
                  <span className="truncate text-[11px] text-white/45">instead of {o.row.name ?? 'no sound'}</span>
                </span>
                {o.suggested ? <span className="ml-auto rounded-full bg-emerald-400/15 px-2 py-0.5 text-[10px] text-emerald-300">Suggested</span> : null}
              </>
            ) : (
              <span>Add as a new {o.label.toLowerCase()} track</span>
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  </div>
  );
}
