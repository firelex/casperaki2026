import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Genre } from '@casperaki/song-schema/schemas';

import { patternsApi, patternsQueryKey, type PatternProposal } from '../api/patterns';
import { livePlayer } from '../audio/livePlayer';
import { useLiveState } from '../audio/useLivePlayer';
import { AppHeader } from '../layout/AppHeader';
import { BassGrid } from '../patterns/BassGrid';
import { DrumGrid } from '../patterns/DrumGrid';
import { GENRE_LABELS } from '../types/genres';

type Filter = 'pending' | 'approved' | 'rejected' | 'all';

/**
 * Pattern lab (admins): review the patterns Casperaki suggests to fill thin
 * styles. Each proposal can be heard inside a full song in its genre, next
 * to the same song with the current library, then approved or rejected.
 * Approved patterns reach new songs once exported into the library
 * (apps/brain/scripts/export-approved-patterns.ts).
 */
export function PatternLabPage() {
  const [filter, setFilter] = useState<Filter>('pending');
  const query = useQuery({ queryKey: patternsQueryKey, queryFn: ({ signal }) => patternsApi.list(signal) });
  const proposals = query.data?.proposals ?? [];
  const count = (f: Filter) => proposals.filter((p) => matches(p, f)).length;
  const shown = proposals.filter((p) => matches(p, filter));

  return (
    <div className="min-h-screen w-full bg-bg text-fg">
      <AppHeader />
      <main className="mx-auto w-full max-w-[1240px] px-4 pb-24 pt-10 sm:px-8 sm:pt-14">
        <h1 className="app-heading text-[30px] leading-tight text-white sm:text-[36px]">Pattern lab</h1>
        <p className="mt-2 max-w-[70ch] text-[15px] leading-relaxed text-white/60">
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
      </main>
    </div>
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
  const [note, setNote] = useState(p.review?.note ?? '');
  const live = useLiveState();
  const review = useMutation({
    mutationFn: (status: 'approved' | 'rejected' | 'pending') => patternsApi.review(p.id, status, note),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: patternsQueryKey }),
  });

  const keyFor = (variant: 'proposal' | 'current') => `pattern:${p.id}:${genre}:${variant}`;
  const listen = (variant: 'proposal' | 'current') => {
    const key = keyFor(variant);
    if (live.key === key && live.status === 'playing') {
      void livePlayer.pause();
      return;
    }
    void livePlayer.play(key, (signal) => patternsApi.preview(p.id, genre, variant, signal));
  };
  const stateOf = (variant: 'proposal' | 'current') => (live.key === keyFor(variant) ? live.status : 'idle');
  const status = p.review?.status;

  return (
    <article className="rounded-[14px] border border-line/60 bg-panel p-5 sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-[20px] font-semibold text-white">{p.name}</h2>
          <p className="mt-1 text-[14px] text-white/55">
            {p.family === 'bass' ? 'Bass' : 'Drums'} ·{' '}
            {p.kind === 'algo' ? 'generator (new variations every song)' : `${p.kind === 'bassPatterns' ? p.patterns.length : p.blueprints.length} fixed patterns`} ·{' '}
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
                  onClick={() => setTake(i)}
                  className={`h-8 rounded-full px-3 text-[13px] ${take === i ? 'bg-white/15 text-white' : 'text-white/55 hover:text-white'}`}
                >
                  Pattern {i + 1}
                </button>
              ))}
            </div>
          ) : null}
          {p.kind === 'bassPatterns' ? <BassGrid pattern={p.patterns[take]!} /> : <DrumGrid blueprint={p.blueprints[take]!} />}
          <p className="mt-2 text-[12px] text-white/40">
            {p.kind === 'bassPatterns'
              ? 'Two bars; each note is an interval from the current chord root, so the line follows the chords.'
              : 'Two bars, 32nd-note steps.'}{' '}
            A song picks among these patterns section by section.
          </p>
        </div>
      ) : (
        <p className="mt-5 text-[14px] text-white/50">Generated fresh for every song and section: listen to hear it.</p>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-3">
        {p.genres.length > 1 ? (
          <select
            value={genre}
            onChange={(e) => setGenre(e.target.value as Genre)}
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
        <ListenButton state={stateOf('proposal')} onClick={() => listen('proposal')} label="With this pattern" primary />
        <ListenButton state={stateOf('current')} onClick={() => listen('current')} label="Current library" />
        {(['proposal', 'current'] as const).map((v) =>
          live.key === keyFor(v) && live.status === 'loading' ? (
            <span key={v} className="text-[13px] text-white/55">{live.step}</span>
          ) : live.key === keyFor(v) && live.status === 'error' ? (
            <span key={v} className="text-[13px] text-err">{live.error}</span>
          ) : null,
        )}
      </div>
      <p className="mt-2 text-[12px] text-white/40">Both play the same {GENRE_LABELS[genre]} song; only {p.family === 'bass' ? 'the bass differs' : 'the drums differ (and parts that follow them)'}.</p>

      <div className="mt-6 flex flex-col gap-3 border-t border-line/60 pt-5 sm:flex-row sm:items-end">
        <label className="flex flex-1 flex-col gap-2">
          <span className="text-[13px] text-white/60">Note (optional)</span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            maxLength={2000}
            placeholder="What works, what doesn't"
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
  return p.kind === 'bassPatterns' ? p.patterns.length : p.kind === 'blueprints' ? p.blueprints.length : 0;
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
