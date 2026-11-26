import { useQuery } from '@tanstack/react-query';

import { singersApi, singersQueryKey } from '../api/singers';
import { AppHeader } from '../layout/AppHeader';

/**
 * The singers: the voices Sing sings in, each with what it sounds like, where the voice came from, and its voice
 * reference to listen to. (Choosing the singer when you sing comes next.)
 */
export function SingersPage() {
  const singers = useQuery({ queryKey: singersQueryKey, queryFn: ({ signal }) => singersApi.list(signal), staleTime: 60_000 });
  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg text-white">
      <AppHeader />
      <main className="min-h-0 flex-1 overflow-y-auto bg-[#1b1c1f] px-6 py-8">
        <div className="mx-auto flex max-w-[760px] flex-col gap-6">
          <div>
            <h1 className="text-[22px] font-semibold">Singers</h1>
            <p className="mt-1 text-[14px] text-white/55">The voices Sing sings in.</p>
          </div>
          {singers.isPending ? <p className="text-[14px] text-white/55">Loading the singers…</p> : null}
          {singers.isError ? (
            <p className="text-[14px] text-err" role="alert">
              The singers could not be loaded: {singers.error instanceof Error ? singers.error.message : String(singers.error)}
            </p>
          ) : null}
          {singers.data?.singers.map((s) => (
            <section key={s.id} className="flex flex-col gap-3 rounded-[12px] border border-line bg-panel p-5">
              <div>
                <h2 className="text-[17px] font-semibold">{s.name}</h2>
                <p className="mt-1 text-[14px] text-white/75">{s.description}</p>
              </div>
              <audio controls preload="none" src={s.previewUrl} className="w-full" aria-label={`${s.name}: voice reference`} />
              <p className="text-[12px] text-white/45">{s.source}</p>
            </section>
          ))}
        </div>
      </main>
    </div>
  );
}
