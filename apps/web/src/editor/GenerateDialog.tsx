import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_BPM_BY_GENRE,
  GENRE_TEMPO_RANGES,
  type Genre,
} from '@casperaki/song-schema/schemas';

import { Button, NumberInput, Select, TextInput } from '../components/Inputs';
import { Field } from '../components/Field';
import { Chip } from '../components/Chip';
import { CANONICAL_GENRES } from '../types/song';
import { BrainError } from '../api/client';
import { songsApi, songsQueryKeys, type GeneratedSong } from '../api/songs';
import { useSession } from '../state/session';

/**
 * Generate dialog — replaces the old standalone GenerationPanel.
 *
 * Triggered from the Projects Create CTA. Hits POST
 * /api/songs/generate, registers the result with the session, and
 * yields control to the caller (which navigates to the editor).
 *
 * Layout: a rory-fe-flavoured modal — `.publish`/`.insert-section`
 * modals in rory are dark, narrow, centered. Same spirit.
 */
export interface GenerateDialogProps {
  open: boolean;
  onClose(): void;
  onCreated(songId: string): void;
}

export function GenerateDialog({ open, onClose, onCreated }: GenerateDialogProps) {
  const queryClient = useQueryClient();
  const { addSong, setActiveSong } = useSession();
  const [genre, setGenre] = useState<Genre>('brightPop');
  const [key, setKey] = useState('C');
  const [bpm, setBpm] = useState(DEFAULT_BPM_BY_GENRE.brightPop);
  const [seed, setSeed] = useState(`session-${Date.now().toString(36).slice(-5)}`);
  const tempoRange = GENRE_TEMPO_RANGES[genre];

  const mutation = useMutation<GeneratedSong, Error>({
    mutationFn: () =>
      songsApi.generate({
        genre,
        key,
        bpm,
        seed: /^-?\d+$/u.test(seed) ? Number(seed) : seed,
      }),
    onSuccess: (data) => {
      addSong(data, { seed, genre });
      setActiveSong(data);
      queryClient.setQueryData(songsQueryKeys.song(data.id), data);
      onCreated(data.id);
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="relative z-10 w-[min(520px,92vw)] rounded-[15px] bg-[#1a1d27] border border-line p-9 shadow-2xl">
        <header className="flex items-center justify-between mb-7">
          <div className="flex items-center gap-3">
            <span className="h-3 w-3 rounded-full bg-accent" aria-hidden="true" />
            <h2 className="text-white text-[22px] font-semibold">Generate song</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="h-9 w-9 rounded-full text-white/70 hover:text-white hover:bg-white/10 text-[18px]"
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <form
          className="grid grid-cols-2 gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            mutation.mutate();
          }}
        >
          <Field label="Genre" hint="canonical brain vocabulary">
            <Select
              value={genre}
              onChange={(e) => {
                const nextGenre = e.target.value as Genre;
                setGenre(nextGenre);
                setBpm(DEFAULT_BPM_BY_GENRE[nextGenre]);
              }}
            >
              {CANONICAL_GENRES.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Key">
            <TextInput
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="C"
              spellCheck={false}
            />
          </Field>
          <Field label="BPM" hint={`${tempoRange.min}-${tempoRange.max}`}>
            <NumberInput
              min={tempoRange.min}
              max={tempoRange.max}
              step={1}
              value={bpm}
              onChange={(e) => setBpm(Number(e.target.value))}
            />
          </Field>
          <Field label="Seed" hint="number or string">
            <TextInput
              value={seed}
              onChange={(e) => setSeed(e.target.value)}
              spellCheck={false}
              className="font-mono"
            />
          </Field>

          <div className="col-span-2 flex items-center justify-between pt-5 mt-2 border-t border-line">
            <div className="text-[12px] text-muted leading-tight max-w-[60%]">
              <Chip tone="neutral">deterministic</Chip>{' '}
              Same seed + params → same hash. POST /api/songs/generate.
            </div>
            <div className="flex items-center gap-2">
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={mutation.isPending}>
                {mutation.isPending ? 'Generating…' : 'Generate'}
              </Button>
            </div>
          </div>

          {mutation.isError ? (
            <div className="col-span-2 -mt-2">
              <BrainErrorBlock error={mutation.error} />
            </div>
          ) : null}
        </form>
      </div>
    </div>
  );
}

function BrainErrorBlock({ error }: { error: Error }) {
  if (error instanceof BrainError) {
    return (
      <div className="text-err text-[12px] font-mono">
        <div>
          {error.body?.error ?? 'error'} · {error.status}
        </div>
        {error.body?.issues?.length ? (
          <ul className="mt-1 list-disc list-inside normal-case">
            {error.body.issues.map((iss, i) => (
              <li key={i}>
                {iss.path}: {iss.message}
              </li>
            ))}
          </ul>
        ) : error.body?.message ? (
          <div className="normal-case">{error.body.message}</div>
        ) : null}
      </div>
    );
  }
  return <span className="text-err text-[12px]">{error.message}</span>;
}
