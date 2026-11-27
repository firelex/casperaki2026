import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { avatarsApi, avatarsQueryKey, type AvatarInfo } from '../api/avatars';
import { singersApi, singersQueryKey, type SingerInfo } from '../api/singers';
import { AppHeader } from '../layout/AppHeader';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** What a card says about the avatar's voice. */
export function voiceText(singerId: string | null, singers: readonly SingerInfo[] | undefined): string {
  if (singerId === null) return 'No voice';
  if (!singers) return 'Voice: loading…';
  const s = singers.find((x) => x.id === singerId);
  return s ? `Voice: ${s.name}` : `Voice: a singer you no longer have (${singerId})`;
}

/**
 * The avatars: the user's characters for the music videos, each with its portrait, name and voice (one of their
 * singers), an Edit (the dressing room) and a Delete. "New avatar" opens an empty dressing room.
 */
export function AvatarsPage() {
  const avatars = useQuery({ queryKey: avatarsQueryKey, queryFn: ({ signal }) => avatarsApi.list(signal) });
  const singers = useQuery({ queryKey: singersQueryKey, queryFn: ({ signal }) => singersApi.list(signal), staleTime: 60_000 });
  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-bg text-white">
      <AppHeader />
      <main className="min-h-0 flex-1 overflow-y-auto bg-[#1b1c1f] px-6 py-8">
        <div className="mx-auto flex max-w-[960px] flex-col gap-6">
          <div className="flex items-end gap-4">
            <div className="min-w-0 flex-1">
              <h1 className="text-[22px] font-semibold">Avatars</h1>
              <p className="mt-1 text-[14px] text-white/55">The characters in your music videos, each with one of your singers' voices.</p>
            </div>
            <Link to="/avatars/new" className="shrink-0 rounded-full bg-white px-4 py-1.5 text-[14px] font-medium text-black hover:bg-white/90">
              New avatar
            </Link>
          </div>
          {avatars.isPending ? <p className="text-[14px] text-white/55">Loading your avatars…</p> : null}
          {avatars.isError ? (
            <p className="text-[14px] text-err" role="alert">
              Your avatars could not be loaded: {message(avatars.error)}
            </p>
          ) : null}
          {singers.isError ? (
            <p className="text-[13px] text-err" role="alert">
              The singers could not be loaded: {message(singers.error)}
            </p>
          ) : null}
          {avatars.data && avatars.data.avatars.length === 0 ? (
            <p className="rounded-[12px] border border-dashed border-line bg-panel p-6 text-[14px] text-white/60">
              No avatars yet. Make one in the dressing room: choose its hair, eyes, skin and clothes, and give it a voice.
            </p>
          ) : null}
          {avatars.data && avatars.data.avatars.length > 0 ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-4">
              {avatars.data.avatars.map((a) => (
                <AvatarCard key={a.id} avatar={a} singers={singers.data?.singers} />
              ))}
            </div>
          ) : null}
        </div>
      </main>
    </div>
  );
}

/** One avatar: its portrait, name and voice, Edit and Delete (asking first). */
export function AvatarCard({ avatar: a, singers }: { avatar: AvatarInfo; singers: readonly SingerInfo[] | undefined }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const remove = async () => {
    setError(undefined);
    try {
      await avatarsApi.remove(a.id);
      await queryClient.invalidateQueries({ queryKey: avatarsQueryKey });
    } catch (err) {
      setError(`Could not delete ${a.name}: ${message(err)}`);
      setConfirming(false);
    }
  };
  return (
    <section className="flex flex-col overflow-hidden rounded-[12px] border border-line bg-panel">
      <div className="aspect-square bg-[radial-gradient(circle_at_50%_35%,#3a3d4a,#1b1c22_75%)]">
        <img src={a.portraitUrl} alt={`${a.name}'s portrait`} className="h-full w-full object-cover" />
      </div>
      <div className="flex flex-col gap-2 p-4">
        <h2 className="truncate text-[16px] font-semibold">{a.name}</h2>
        <p className="truncate text-[13px] text-white/60">{voiceText(a.singerId, singers)}</p>
        {confirming ? (
          <span className="flex flex-wrap items-center gap-2 text-[13px]">
            Delete {a.name}?
            <button type="button" className="rounded-full border border-err/60 px-3 py-1 text-err hover:border-err" onClick={() => void remove()}>
              Delete
            </button>
            <button type="button" className="rounded-full border border-white/30 px-3 py-1 text-white/80 hover:border-white/60" onClick={() => setConfirming(false)}>
              Keep
            </button>
          </span>
        ) : (
          <span className="flex items-center gap-2 text-[13px]">
            <Link to={`/avatars/${encodeURIComponent(a.id)}`} className="rounded-full border border-white/30 px-3 py-1 text-white hover:border-white/60">
              Edit
            </Link>
            <button type="button" className="rounded-full border border-white/30 px-3 py-1 text-white/80 hover:border-white/60" onClick={() => setConfirming(true)}>
              Delete
            </button>
          </span>
        )}
        {error ? (
          <p className="text-[13px] text-err" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
