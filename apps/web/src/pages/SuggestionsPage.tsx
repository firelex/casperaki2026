import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';

import { suggestionsApi, type GenreMixSuggestions, type MixChange } from '../api/suggestions';
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
  return (
    <article className="rounded-[14px] border border-line/60 bg-panel p-5 sm:p-7">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[20px] font-semibold text-white">{(GENRE_LABELS as Record<string, string>)[g.genre] ?? g.genre}</h2>
        <span className="text-[13px] text-white/50">
          {g.songs} {g.songs === 1 ? 'song' : 'songs'} with a Pro mix
        </span>
      </div>
      {dismiss.isError ? <p className="mt-2 text-[13px] text-err">Not deleted: {dismiss.error.message}</p> : null}
      <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-[13px]">
            <thead className="text-[12px] text-white/45">
              <tr>
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
                  <tr key={c.key} className="border-t border-line/40 align-top">
                    <td className="py-2 pr-4 text-white">{d.what}</td>
                    <td className="py-2 pr-4 font-mono text-white/60">{d.show(c.standard)}</td>
                    <td className="py-2 pr-4 font-mono text-[#ffb347]">{d.show(c.average)}</td>
                    <td className="py-2 text-white/70">
                      {c.values.length}
                      <span className="ml-2 text-white/40" title={c.values.map((v) => `${v.title}${v.lane ? ` (${v.lane})` : ''}: ${d.show(v.value)}`).join('\n')}>
                        {c.values.slice(0, 3).map((v) => `${v.title}: ${d.show(v.value)}`).join(' · ')}
                        {c.values.length > 3 ? ' …' : ''}
                      </span>
                    </td>
                    <td className="py-1.5 pl-3 text-right">
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
  if (c.kind === 'volume') return { what: `${trackLabel(c)}: level`, show: dB };
  if (c.kind === 'send') return { what: `${trackLabel(c)}: ${SEND_NAMES[c.detail!.send!]} send`, show: dB };
  const { plugin, slot, param } = c.detail!;
  const p = describeParam(plugin!, param!);
  const bus = c.target === 'master' ? 'Master' : `${c.target} bus`;
  return { what: `${bus} · ${pluginTitle(plugin!)} (slot ${slot! + 1}) · ${p.name}`, show: p.display };
}
