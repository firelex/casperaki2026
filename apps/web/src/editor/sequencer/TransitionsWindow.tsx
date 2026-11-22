import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@teamsuzie/ui';

import { soundsApi } from '../../api/sounds';
import type { TransitionPlacement, TransitionState } from '../../api/tracks';
import { audition } from '../../audio/audition';
import { SoundBrowser, stopSoundPreview } from '../sounds/SoundBrowser';

const PLACES: readonly { placement: TransitionPlacement; label: string }[] = [
  { placement: 'beginningOfSegment', label: 'Start' },
  { placement: 'midSegment', label: 'Middle' },
  { placement: 'endOfSegment', label: 'End' },
];
const PLACE_SHORT: Record<TransitionPlacement, string> = { beginningOfSegment: 'start', midSegment: 'middle', endOfSegment: 'end' };

export interface TransitionOp {
  segments: string[];
  type: string;
  placement: TransitionPlacement;
  on: boolean;
  soundId?: string;
}

/**
 * A section's transitions (risers, impacts, reverses, crashes, fills, snare
 * rolls): what is there, for this section or every section of its kind, with
 * the sound each plays (hear it, choose another), plus an overview of the
 * whole song. Every change is one undoable edit.
 */
export function TransitionsWindow({
  section,
  sections,
  state,
  busy,
  error,
  onSet,
  onSelectSection,
  onClose,
  songStyle,
}: {
  /** The song's style: sound lists start with the sounds that suit it. */
  songStyle: string | undefined;
  section: string;
  /** Every section in song order, with its kind (verse, chorus, …). */
  sections: readonly { name: string; kind: string }[];
  state: TransitionState | { error: string } | undefined;
  busy: string | undefined;
  error: string | undefined;
  onSet(op: TransitionOp): void;
  onSelectSection(name: string): void;
  onClose(): void;
}) {
  const [scope, setScope] = useState<'this' | 'all'>('this');
  const [picking, setPicking] = useState<{ type: string; label: string; placement: TransitionPlacement; current: string | null } | undefined>(undefined);
  useEffect(() => () => audition.stop(), []);
  const kind = sections.find((s) => s.name === section)?.kind;
  if (!kind) throw new Error(`No section ${section}.`);
  const sameKind = sections.filter((s) => s.kind === kind).map((s) => s.name);
  const segments = scope === 'this' ? [section] : sameKind;
  const kindLabel = pluralKind(kind);
  const ready = state && !('error' in state) ? state : undefined;
  const labelOf = (type: string) => ready?.types.find((t) => t.type === type)?.label ?? type;

  // What the sections in scope have, per transition type.
  // `names`: what each plays (also for songs saved before sounds were stored, where soundId is null).
  const present = new Map<string, { placement: TransitionPlacement; count: number; sounds: Map<string, string>; names: Set<string> }>();
  for (const seg of segments) {
    for (const t of ready?.sections[seg] ?? []) {
      const cur = present.get(t.type) ?? { placement: t.placement, count: 0, sounds: new Map<string, string>(), names: new Set<string>() };
      cur.count++;
      if (t.soundId) cur.sounds.set(t.soundId, t.soundName ?? t.soundId);
      if (t.soundName) cur.names.add(t.soundName);
      present.set(t.type, cur);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent className="flex max-h-[90vh] w-[min(980px,calc(100vw-2rem))] max-w-none flex-col gap-0 overflow-hidden rounded-[12px] border border-line bg-[#1b1c1f] p-0 text-white sm:max-w-none">
        <div className="border-b border-line/60 px-5 py-4 pr-12">
          <DialogTitle className="text-[17px] font-semibold text-white">Transitions · {scope === 'this' ? section : `all ${kindLabel}`}</DialogTitle>
          <DialogDescription className="mt-1 text-[13px] text-white/55">
            Risers, impacts, reverses and fills around the section. Press ▶ to hear a sound; Sound… picks another. Undo with Ctrl+Z.
          </DialogDescription>
          {sameKind.length > 1 ? (
            <div className="mt-3 flex gap-1" role="group" aria-label="Apply to">
              {(
                [
                  ['this', `${section} only`],
                  ['all', `All ${kindLabel} (${sameKind.length})`],
                ] as const
              ).map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={scope === v}
                  onClick={() => setScope(v)}
                  className={`h-8 rounded-full border px-3 text-[13px] ${scope === v ? 'border-white bg-white text-black' : 'border-line text-white/80 hover:border-white/50'}`}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_260px] overflow-hidden">
          {/* This section (or all of its kind): start, middle, end. */}
          <div className="min-h-0 overflow-y-auto px-5 py-4">
            {state === undefined ? (
              <p className="text-[13px] text-white/55">Reading the transitions…</p>
            ) : 'error' in state ? (
              <p className="text-[13px] text-err">{state.error}</p>
            ) : (
              PLACES.map((place) => {
                const here = [...present.entries()].filter(([, p]) => p.placement === place.placement);
                const addable = state.types.filter((t) => t.placements.includes(place.placement) && present.get(t.type)?.count !== segments.length);
                return (
                  <section key={place.placement} className="mb-5" aria-label={`At the ${PLACE_SHORT[place.placement]}`}>
                    <div className="mb-2 flex items-center gap-3">
                      <h3 className="text-[13px] font-semibold text-white/80">{place.label}</h3>
                      <div className="h-px flex-1 bg-line/60" />
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild disabled={Boolean(busy) || addable.length === 0}>
                          <button type="button" className="h-7 rounded-full border border-white/25 px-3 text-[12px] text-white hover:border-white/60 disabled:opacity-30">
                            + Add
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="z-[80] min-w-[200px] rounded-[10px] border border-line bg-panel p-1 text-white shadow-2xl">
                          {addable.map((t) => (
                            <DropdownMenuItem
                              key={t.type}
                              onSelect={() => onSet({ segments, type: t.type, placement: place.placement, on: true })}
                              className="cursor-pointer rounded-[6px] px-3 py-2 text-[13px] outline-none data-[highlighted]:bg-white/10"
                            >
                              {t.label}
                              {present.has(t.type) ? <span className="ml-2 text-white/45">(to the rest)</span> : null}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                    {here.length === 0 ? <p className="px-1 text-[12px] text-white/35">None</p> : null}
                    {here.map(([type, p]) => {
                      const sounds = [...p.sounds.entries()];
                      const swappable = state.types.find((t) => t.type === type)?.swappable ?? false;
                      return (
                        <div key={type} className="mb-1 flex items-center gap-3 rounded-[8px] bg-white/[0.04] px-3 py-2">
                          <PreviewButton soundId={sounds[0]?.[0]} label={labelOf(type)} />
                          <div className="min-w-0 flex-1">
                            <div className="text-[14px] text-white">
                              {labelOf(type)}
                              {p.count < segments.length ? <span className="ml-2 text-[12px] text-white/45">in {p.count} of {segments.length}</span> : null}
                            </div>
                            <div className="truncate text-[12px] text-white/50">
                              {p.names.size === 0 ? (swappable ? 'No sound found' : 'Generated') : p.names.size === 1 ? [...p.names][0] : `${p.names.size} different sounds`}
                            </div>
                          </div>
                          {swappable ? (
                            <button
                              type="button"
                              disabled={Boolean(busy)}
                              onClick={() => setPicking({ type, label: labelOf(type), placement: p.placement, current: sounds.length === 1 ? sounds[0]![0] : null })}
                              className="h-7 rounded-full border border-white/25 px-3 text-[12px] text-white hover:border-white/60 disabled:opacity-40"
                            >
                              Sound…
                            </button>
                          ) : null}
                          <button
                            type="button"
                            disabled={Boolean(busy)}
                            onClick={() => onSet({ segments, type, placement: p.placement, on: false })}
                            className="h-7 rounded-full px-3 text-[12px] text-white/70 hover:bg-white/10 hover:text-white disabled:opacity-40"
                            aria-label={`Remove the ${labelOf(type).toLowerCase()}`}
                          >
                            Remove
                          </button>
                        </div>
                      );
                    })}
                  </section>
                );
              })
            )}
          </div>

          {/* The whole song. */}
          <aside className="min-h-0 overflow-y-auto border-l border-line/60 bg-[#202124] px-3 py-4" aria-label="Transitions in the song">
            <h3 className="mb-2 px-1 text-[12px] font-semibold text-white/60">In the song</h3>
            {sections.map((s) => {
              const ts = ready?.sections[s.name] ?? [];
              const inScope = segments.includes(s.name);
              return (
                <button
                  key={s.name}
                  type="button"
                  onClick={() => {
                    onSelectSection(s.name);
                    setScope('this');
                  }}
                  aria-current={s.name === section ? 'true' : undefined}
                  className={`mb-1 block w-full rounded-[6px] px-2 py-1.5 text-left ${s.name === section ? 'bg-[#3a3c43]' : inScope ? 'bg-white/[0.06]' : 'hover:bg-white/5'}`}
                >
                  <div className="text-[12px] font-semibold text-white/85">{s.name}</div>
                  <div className="text-[11px] leading-snug text-white/45">
                    {ts.length === 0 ? '—' : ts.map((t) => `${labelOf(t.type)} (${PLACE_SHORT[t.placement]})`).join(', ')}
                  </div>
                </button>
              );
            })}
          </aside>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-line/60 px-5 py-3 text-[12px]">
          <span className={error ? 'text-err' : 'text-white/55'} role={error ? 'alert' : 'status'}>
            {error ?? (busy ? `${busy}…` : '')}
          </span>
          <button type="button" onClick={onClose} className="h-9 rounded-full px-4 text-[14px] text-white/80 hover:text-white">
            Done
          </button>
        </div>
      </DialogContent>

      {picking ? (
        <TransitionSoundDialog
          label={picking.label}
          type={picking.type}
          current={picking.current}
          where={scope === 'this' ? section : `all ${kindLabel}`}
          songStyle={songStyle}
          onClose={() => setPicking(undefined)}
          onPick={(soundId) => {
            onSet({ segments, type: picking.type, placement: picking.placement, on: true, soundId });
            setPicking(undefined);
          }}
        />
      ) : null}
    </Dialog>
  );
}

/** ▶ / ■ for one transition sound (played once). */
function PreviewButton({ soundId, label }: { soundId: string | undefined; label: string }) {
  const [playing, setPlaying] = useState(false);
  useEffect(() => audition.onChange((id, st) => setPlaying(id === soundId && st !== 'idle')), [soundId]);
  return (
    <button
      type="button"
      disabled={!soundId}
      onClick={() => (playing ? audition.stop() : soundId ? void audition.play(soundId, soundsApi.audioUrl(soundId), 'fx') : undefined)}
      aria-label={playing ? `Stop the ${label.toLowerCase()}` : `Play the ${label.toLowerCase()}`}
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-black/60 text-[11px] ${playing ? 'bg-emerald-400 text-black' : 'bg-gradient-to-b from-[#3b3d43] to-[#2b2c31] text-white hover:from-[#4a4c53]'} disabled:opacity-30`}
    >
      {playing ? '■' : '▶'}
    </button>
  );
}

/** Pick the sound of a transition from every sound that type can play. */
function TransitionSoundDialog({
  label,
  type,
  current,
  where,
  songStyle,
  onPick,
  onClose,
}: {
  songStyle: string | undefined;
  label: string;
  type: string;
  current: string | null;
  where: string;
  onPick(soundId: string): void;
  onClose(): void;
}) {
  useEffect(() => stopSoundPreview, []);
  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent className="z-[90] flex h-[min(86vh,900px)] w-[min(1100px,calc(100vw-2rem))] max-w-none flex-col gap-0 overflow-hidden rounded-[12px] border border-line bg-[#1b1c1f] p-0 text-white sm:max-w-none">
        <div className="border-b border-line/60 px-5 py-4 pr-12">
          <DialogTitle className="text-[17px] font-semibold text-white">
            {label} sound for {where}
          </DialogTitle>
          <DialogDescription className="mt-1 text-[13px] text-white/55">Press play (or Space) to hear a sound; Use puts it in.</DialogDescription>
        </div>
        <SoundBrowser
          source={{ transition: type }}
          songStyle={songStyle}
          title={`${label} sounds`}
          actionLabel=""
          highlight={current ?? undefined}
          playOnce
          autoFocus
          action={(s) =>
            s.id === current ? (
              <span className="text-[12px] text-white/50">Current</span>
            ) : (
              <button
                type="button"
                onClick={() => onPick(s.id)}
                className="h-7 rounded-full border border-white/25 px-4 text-[12px] text-white hover:border-white hover:bg-white hover:text-black"
              >
                Use
              </button>
            )
          }
        />
      </DialogContent>
    </Dialog>
  );
}

/** "chorus" → "choruses", "preChorus" → "pre-choruses". */
export function pluralKind(kind: string): string {
  const k = kind.replace(/([a-z])([A-Z])/gu, '$1-$2').toLowerCase();
  return /(s|x|ch|sh)$/u.test(k) ? `${k}es` : `${k}s`;
}
