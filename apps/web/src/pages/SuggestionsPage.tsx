import { Fragment, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { BulkActionBarItemBar, Checkbox } from '@teamsuzie/ui';

import { suggestionsApi, type GenreMixSuggestions, type MixChange } from '../api/suggestions';
import { CommentBox, CommentList } from '../components/SuggestionComments';
import { describeParam, pluginTitle } from '../editor/devices/ProParams';
import { AppHeader } from '../layout/AppHeader';
import { GENRE_LABELS } from '../types/genres';
import { PatternsSection } from './PatternLabPage';

const TABS = [
  { id: 'patterns', label: 'Patterns' },
  { id: 'mix', label: 'Mix' },
] as const;
type Tab = (typeof TABS)[number]['id'];

/**
 * Suggestions (admins): what could improve the standard library and mix.
 * Patterns: Casperaki-written patterns to approve or reject (the pattern lab).
 * Mix: what users changed in the track view's Pro mode, per genre, next to
 * the standard value.
 */
export function SuggestionsPage() {
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get('tab') === 'mix' ? 'mix' : 'patterns';
  return (
    <div className="min-h-screen w-full bg-bg text-fg">
      <AppHeader />
      <main className="mx-auto w-full max-w-[1240px] px-4 pb-24 pt-10 sm:px-8 sm:pt-14">
        <h1 className="app-heading text-[30px] leading-tight text-white sm:text-[36px]">Suggestions</h1>
        <div className="mt-6 flex gap-6 border-b border-line/60" role="tablist" aria-label="Suggestions">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setParams(t.id === 'patterns' ? {} : { tab: t.id })}
              className={`-mb-px border-b-2 pb-2 text-[16px] ${tab === t.id ? 'border-accent text-white' : 'border-transparent text-white/55 hover:text-white'}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        {tab === 'patterns' ? <PatternsSection /> : <MixSection />}
      </main>
    </div>
  );
}

function MixSection() {
  const query = useQuery({ queryKey: ['suggestions', 'mix'], queryFn: ({ signal }) => suggestionsApi.mix(signal) });
  return (
    <>
      <p className="mt-6 max-w-[72ch] text-[15px] leading-relaxed text-white/60">
        What people changed in the track view&rsquo;s Pro mode, per genre: levels, sends and plugin settings, next to
        the standard mix. A change many songs of a genre agree on is a good candidate for the standard mix.
      </p>
      <div className="mt-8 flex flex-col gap-6">
        {query.isLoading ? (
          <p className="text-white/55">Loading…</p>
        ) : query.isError ? (
          <p className="text-err">The mix suggestions could not be loaded: {query.error.message}</p>
        ) : query.data!.genres.length === 0 ? (
          <p className="text-white/55">No Pro-mode mixes yet. Open a song, switch the mixer to Pro and change something.</p>
        ) : (
          query.data!.genres.map((g) => <GenreCard key={g.genre} g={g} />)
        )}
      </div>
    </>
  );
}

function GenreCard({ g }: { g: GenreMixSuggestions }) {
  const queryClient = useQueryClient();
  const dismiss = useMutation({
    mutationFn: (key: string) => suggestionsApi.dismissMix(g.genre, key),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['suggestions', 'mix'] }),
  });
  const approve = useMutation({
    mutationFn: (key: string) => suggestionsApi.approveMix(g.genre, key),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['suggestions', 'mix'] }),
  });
  const comment = useMutation({
    mutationFn: ({ key, body }: { key: string; body: string }) => suggestionsApi.commentMix(g.genre, key, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['suggestions', 'mix'] }),
  });
  /** The change whose comment box is open. */
  const [open, setOpen] = useState<string | undefined>(undefined);
  // Bulk actions on the ticked changes (approve skips those that cannot be approved).
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const selected = g.changes.filter((c) => ticked.has(c.key));
  const approvable = selected.filter((c) => !c.blocked);
  const genreLabel = (GENRE_LABELS as Record<string, string>)[g.genre] ?? g.genre;
  const done = () => {
    setTicked(new Set());
    void queryClient.invalidateQueries({ queryKey: ['suggestions', 'mix'] });
  };
  const approveMany = useMutation({ mutationFn: (keys: string[]) => suggestionsApi.approveMixMany(g.genre, keys), onSuccess: done });
  const dismissMany = useMutation({ mutationFn: (keys: string[]) => suggestionsApi.dismissMixMany(g.genre, keys), onSuccess: done });
  const bulkBusy = approveMany.isPending || dismissMany.isPending;
  const approveSelected = () => {
    const all = approvable.some((c) => c.scope === 'all');
    const skipped = selected.length - approvable.length;
    const msg =
      `Make the average the standard for ${approvable.length} ${approvable.length === 1 ? 'change' : 'changes'} (${genreLabel}${all ? '; some apply to every genre' : ''})?` +
      (skipped ? ` ${skipped} selected ${skipped === 1 ? 'change cannot' : 'changes cannot'} be approved and ${skipped === 1 ? 'is' : 'are'} left out.` : '') +
      ' New songs and songs without their own setting will use them.';
    if (window.confirm(msg)) approveMany.mutate(approvable.map((c) => c.key));
  };
  const tick = (key: string, on: boolean) =>
    setTicked((t) => {
      const next = new Set(t);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  return (
    <article className="ts-scope rounded-[14px] border border-line/60 bg-panel p-5 sm:p-7">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[20px] font-semibold text-white">{(GENRE_LABELS as Record<string, string>)[g.genre] ?? g.genre}</h2>
        <span className="text-[13px] text-white/50">
          {g.songs} {g.songs === 1 ? 'song' : 'songs'} with a Pro mix
        </span>
      </div>
      {dismiss.isError ? <p className="mt-2 text-[13px] text-err">Not deleted: {dismiss.error.message}</p> : null}
      {approve.isError ? <p className="mt-2 text-[13px] text-err" role="alert">Not approved: {approve.error.message}</p> : null}
      {approve.isSuccess ? <p className="mt-2 text-[13px] text-emerald-300">Now the standard: {approve.data.summary}.</p> : null}
      {approveMany.isError ? <p className="mt-2 text-[13px] text-err" role="alert">None approved: {approveMany.error.message}</p> : null}
      {approveMany.isSuccess ? <p className="mt-2 text-[13px] text-emerald-300">Now the standard: {approveMany.data.summaries.join('; ')}.</p> : null}
      {dismissMany.isError ? <p className="mt-2 text-[13px] text-err">Not deleted: {dismissMany.error.message}</p> : null}
      <BulkActionBarItemBar
        className="mt-4"
        selectionCount={selected.length}
        itemNoun="change"
        onClear={() => setTicked(new Set())}
        actions={[
          { id: 'delete', label: 'Delete', variant: 'outline', disabled: bulkBusy, onClick: () => dismissMany.mutate(selected.map((c) => c.key)) },
          {
            id: 'approve',
            label: approveMany.isPending ? 'Approving…' : approvable.length === selected.length ? 'Approve' : `Approve ${approvable.length}`,
            variant: 'default',
            disabled: bulkBusy || approvable.length === 0,
            onClick: approveSelected,
          },
        ]}
      />
      <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-[13px]">
            <thead className="text-[12px] text-white/45">
              <tr>
                <th className="w-7 pb-2 font-normal">
                  <Checkbox
                    aria-label="Select all changes"
                    checked={selected.length > 0}
                    indeterminate={selected.length > 0 && selected.length < g.changes.length}
                    onChange={(e) => setTicked(e.target.checked ? new Set(g.changes.map((c) => c.key)) : new Set())}
                  />
                </th>
                <th className="pb-2 font-normal">What</th>
                <th className="pb-2 font-normal">Standard</th>
                <th className="pb-2 font-normal">Pro (average)</th>
                <th className="pb-2 font-normal">Songs</th>
                <th className="pb-2 font-normal" aria-label="Delete" />
              </tr>
            </thead>
            <tbody>
              {g.changes.map((c) => {
                const d = describe(c);
                return (
                  <Fragment key={c.key}>
                  <tr className="border-t border-line/40 align-top">
                    <td className="py-2 pr-2">
                      <Checkbox aria-label={`Select ${d.what}`} checked={ticked.has(c.key)} onChange={(e) => tick(c.key, e.target.checked)} />
                    </td>
                    <td className="py-2 pr-4 text-white">
                      {d.what}
                      {c.scope === 'all' ? (
                        <span className="ml-2 rounded-full bg-white/10 px-2 py-[1px] text-[11px] text-white/60" title="The standard mix sets this once for every genre: approving it changes it in all of them.">
                          all genres
                        </span>
                      ) : null}
                    </td>
                    <td className="py-2 pr-4 font-mono text-white/60">{c.standard === null ? 'per sound' : d.show(c.standard)}</td>
                    <td className="py-2 pr-4 font-mono text-[#ffb347]">{d.show(c.average)}</td>
                    <td className="py-2 text-white/70">
                      {c.values.length}
                      <span className="ml-2 text-white/40" title={c.values.map((v) => `${v.title}${v.lane ? ` (${v.lane})` : ''}: ${d.show(v.value)}`).join('\n')}>
                        {c.values.slice(0, 3).map((v) => `${v.title}: ${d.show(v.value)}`).join(' · ')}
                        {c.values.length > 3 ? ' …' : ''}
                      </span>
                    </td>
                    <td className="whitespace-nowrap py-1.5 pl-3 text-right">
                      <button
                        type="button"
                        onClick={() => setOpen(open === c.key ? undefined : c.key)}
                        aria-expanded={open === c.key}
                        title="Leave a comment on this change"
                        className="mr-2 h-7 rounded-full border border-white/20 px-3 text-[12px] text-white/70 hover:border-white/60 hover:text-white"
                      >
                        Comment{c.comments.length ? ` (${c.comments.length})` : ''}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          const where = c.scope === 'all' ? 'every genre' : `${(GENRE_LABELS as Record<string, string>)[g.genre] ?? g.genre} only`;
                          if (window.confirm(`Make ${d.show(c.average)} the standard for “${d.what}” (${where})? New songs and songs without their own setting will use it.`)) approve.mutate(c.key);
                        }}
                        disabled={approve.isPending || Boolean(c.blocked)}
                        title={c.blocked ?? `Make the average the standard mix (${c.scope === 'all' ? 'every genre' : 'this genre'}). Songs with their own setting keep sounding the same.`}
                        className="mr-2 h-7 rounded-full border border-emerald-400/50 px-3 text-[12px] text-emerald-300 hover:border-emerald-300 hover:text-emerald-200 disabled:cursor-not-allowed disabled:opacity-35"
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        onClick={() => dismiss.mutate(c.key)}
                        disabled={dismiss.isPending}
                        title="Remove this suggestion. The songs keep their mixes; it comes back if someone changes it again."
                        className="h-7 rounded-full border border-white/20 px-3 text-[12px] text-white/70 hover:border-err hover:text-err disabled:opacity-40"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                  {open === c.key ? (
                    <tr>
                      <td colSpan={6} className="pb-3 pt-1">
                        <CommentBox
                          comments={c.comments}
                          onComment={(body) => comment.mutateAsync({ key: c.key, body })}
                          pending={comment.isPending}
                          error={comment.isError ? comment.error.message : undefined}
                        />
                      </td>
                    </tr>
                  ) : c.comments.length ? (
                    <tr>
                      <td colSpan={6} className="pb-3 pt-1">
                        <CommentList comments={c.comments} />
                      </td>
                    </tr>
                  ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
    </article>
  );
}

const dB = (v: number) => (v <= -100 ? 'off' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(Math.round(v * 10) / 10)} dB`);
const SEND_NAMES = { reverb: 'Reverb', delay: 'Delay', chorus: 'Chorus' } as const;

/** The tracks a change was made on, and their sound type ("Drums · kickDrumsElectronic"). */
function trackLabel(c: MixChange): string {
  const lanes = [...new Set(c.values.map((v) => v.lane).filter((l): l is string => Boolean(l)))];
  return lanes.length ? `${lanes.join(', ')} · ${c.target}` : c.target;
}

function describe(c: MixChange): { what: string; show: (v: number) => string } {
  if (c.kind === 'route') {
    const { bus, standardBus } = c.detail!;
    // Standard shows the type's standard bus; Pro and each song the bus it was sent to.
    return { what: `${trackLabel(c)}: output bus`, show: (v) => (v === 0 ? `${standardBus!} bus` : `→ ${bus!} bus`) };
  }
  if (c.kind === 'volume') return { what: `${trackLabel(c)}: level`, show: dB };
  if (c.kind === 'send') return { what: `${trackLabel(c)}: ${SEND_NAMES[c.detail!.send!]} send`, show: dB };
  const { plugin, slot, param } = c.detail!;
  const p = describeParam(plugin!, param!);
  const bus = c.target === 'master' ? 'Master' : `${c.target} bus`;
  return { what: `${bus} · ${pluginTitle(plugin!)} (slot ${slot! + 1}) · ${p.name}`, show: p.display };
}
