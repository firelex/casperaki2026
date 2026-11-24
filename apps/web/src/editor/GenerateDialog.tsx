import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DEFAULT_BPM_BY_GENRE, GENRE_TEMPO_RANGES, type Genre } from '@casperaki/song-schema/schemas';

import { BrainError } from '../api/client';
import { songsApi, songsQueryKeys, type GeneratedSong } from '../api/songs';
import { useSession } from '../state/session';
import { GENRE_BLURBS, GENRE_LABELS } from '../types/genres';
import { CANONICAL_GENRES } from '../types/song';

/**
 * "New song" dialog: pick a genre, optionally a title, tempo and key, and
 * Casperaki writes a first draft (POST /api/songs/generate). The seed —
 * which makes a draft reproducible — sits under "More options".
 */
export interface GenerateDialogProps {
  open: boolean;
  /** Genre preselected when the dialog opens (e.g. from the empty state). */
  initialGenre?: Genre;
  onClose(): void;
  onCreated(songId: string): void;
}

const TONICS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'] as const;
const KEY_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  ...TONICS.map((t) => ({ value: t, label: `${t} major` })),
  ...TONICS.map((t) => ({ value: `${t}m`, label: `${t} minor` })),
];

const randomSeed = () => `seed-${Math.random().toString(36).slice(2, 8)}`;

export function GenerateDialog({ open, initialGenre, onClose, onCreated }: GenerateDialogProps) {
  const queryClient = useQueryClient();
  const { setActiveSong } = useSession();
  const [title, setTitle] = useState('');
  const [genre, setGenre] = useState<Genre>(initialGenre ?? 'brightPop');
  const [key, setKey] = useState('C');
  const [bpm, setBpm] = useState(DEFAULT_BPM_BY_GENRE[initialGenre ?? 'brightPop']);
  const [seed, setSeed] = useState(randomSeed);
  const tempoRange = GENRE_TEMPO_RANGES[genre];

  // Each opening starts fresh, on the requested genre.
  useEffect(() => {
    if (!open) return;
    const g = initialGenre ?? 'brightPop';
    setTitle('');
    setGenre(g);
    setBpm(DEFAULT_BPM_BY_GENRE[g]);
    setKey('C');
    setSeed(randomSeed());
  }, [open, initialGenre]);

  const mutation = useMutation<GeneratedSong, Error>({
    mutationFn: () =>
      songsApi.generate({
        genre,
        key,
        bpm,
        seed: /^-?\d+$/u.test(seed) ? Number(seed) : seed,
        ...(title.trim() ? { title: title.trim() } : {}),
      }),
    onSuccess: (data) => {
      setActiveSong(data);
      void queryClient.invalidateQueries({ queryKey: songsQueryKeys.list });
      queryClient.setQueryData(songsQueryKeys.song(data.id), data);
      onCreated(data.id);
      // Untitled songs are named by the server's language model a moment
      // after they are created: re-read the project so the title shows up.
      if (!title.trim()) {
        for (const ms of [1500, 5000]) {
          window.setTimeout(() => {
            void queryClient.invalidateQueries({ queryKey: songsQueryKeys.list });
            void queryClient.invalidateQueries({ queryKey: songsQueryKeys.song(data.id) });
          }, ms);
        }
      }
    },
  });

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const pickGenre = (g: Genre) => {
    setGenre(g);
    setBpm(DEFAULT_BPM_BY_GENRE[g]);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-song-title"
        className="relative z-10 max-h-[92vh] w-full overflow-y-auto rounded-t-[16px] border border-line bg-panel p-6 shadow-2xl sm:w-[min(640px,94vw)] sm:rounded-[16px] sm:p-8"
      >
        <header className="mb-6 flex items-center justify-between">
          <h2 id="new-song-title" className="app-heading text-[26px] text-white">
            New song
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="h-9 w-9 rounded-full text-[18px] text-white/70 hover:bg-white/10 hover:text-white"
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <form
          className="flex flex-col gap-6"
          onSubmit={(e) => {
            e.preventDefault();
            mutation.mutate();
          }}
        >
          <fieldset>
            <legend className="mb-3 text-[14px] font-semibold text-white">Genre</legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {CANONICAL_GENRES.map((g) => {
                const selected = g === genre;
                return (
                  <label
                    key={g}
                    className={`flex cursor-pointer flex-col gap-1 rounded-[10px] border px-3 py-3 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-white/70 ${
                      selected ? 'border-accent bg-accent/10' : 'border-line bg-panel-2/60 hover:border-line-2'
                    }`}
                  >
                    <input
                      type="radio"
                      name="genre"
                      value={g}
                      checked={selected}
                      onChange={() => pickGenre(g)}
                      className="sr-only"
                    />
                    <span className="text-[15px] font-semibold text-white">{GENRE_LABELS[g]}</span>
                    <span className="text-[12px] leading-snug text-white/55">{GENRE_BLURBS[g]}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          <label className="flex flex-col gap-2">
            <span className="text-[14px] font-semibold text-white">
              Title <span className="font-normal text-white/50">(optional)</span>
            </span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Leave empty and Casperaki names it"
              maxLength={120}
              className="h-11 rounded-[8px] border border-line bg-bg px-3 text-[15px] text-white outline-none placeholder:text-white/35 focus:border-white/50"
            />
          </label>

          <div className="grid gap-6 sm:grid-cols-2">
            <label className="flex flex-col gap-2">
              <span className="flex items-baseline justify-between text-[14px] font-semibold text-white">
                Tempo
                <span className="font-normal text-white/70">{bpm} BPM</span>
              </span>
              <input
                type="range"
                min={tempoRange.min}
                max={tempoRange.max}
                step={1}
                value={bpm}
                onChange={(e) => setBpm(Number(e.target.value))}
                className="h-11 accent-[#ff0000]"
              />
              <span className="flex justify-between text-[12px] text-white/45">
                <span>{tempoRange.min}</span>
                <span>{tempoRange.max}</span>
              </span>
            </label>
            <label className="flex flex-col gap-2">
              <span className="text-[14px] font-semibold text-white">Key</span>
              <select
                value={key}
                onChange={(e) => setKey(e.target.value)}
                className="h-11 rounded-[8px] border border-line bg-bg px-3 text-[15px] text-white outline-none focus:border-white/50"
              >
                {KEY_OPTIONS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <details className="group rounded-[10px] border border-line/70 px-4 py-3">
            <summary className="cursor-pointer list-none text-[14px] text-white/75 marker:hidden">
              More options
            </summary>
            <div className="mt-3 flex flex-col gap-2">
              <span className="text-[13px] text-white/60">
                The seed decides the draft. The same genre, tempo, key and seed always give the same song.
              </span>
              <div className="flex gap-2">
                <input
                  value={seed}
                  onChange={(e) => setSeed(e.target.value)}
                  spellCheck={false}
                  aria-label="Seed"
                  className="h-10 flex-1 rounded-[8px] border border-line bg-bg px-3 font-mono text-[14px] text-white outline-none focus:border-white/50"
                />
                <button
                  type="button"
                  onClick={() => setSeed(randomSeed())}
                  className="h-10 rounded-[8px] border border-line px-3 text-[14px] text-white/85 hover:border-white/50"
                >
                  Surprise me
                </button>
              </div>
            </div>
          </details>

          {mutation.isError ? <ErrorLine error={mutation.error} /> : null}
          {mutation.isPending ? (
            <p className="text-[14px] text-white/60">Writing the melody and the lyrics. This takes a minute or two.</p>
          ) : null}

          <div className="flex items-center justify-end gap-3 border-t border-line pt-5">
            <button type="button" onClick={onClose} className="h-11 rounded-full px-5 text-[15px] text-white/75 hover:text-white">
              Cancel
            </button>
            <button
              type="submit"
              disabled={mutation.isPending}
              className="h-11 rounded-full bg-accent px-6 text-[15px] font-semibold text-white transition-colors hover:bg-[#e00000] disabled:opacity-60"
            >
              {mutation.isPending ? 'Creating…' : 'Create song'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ErrorLine({ error }: { error: Error }) {
  const detail =
    error instanceof BrainError
      ? (error.body?.issues?.map((i) => `${i.path}: ${i.message}`).join('; ') ?? error.body?.message ?? error.message)
      : error.message;
  return (
    <p className="text-[14px] text-err" role="alert">
      The song could not be created: {detail}
    </p>
  );
}
