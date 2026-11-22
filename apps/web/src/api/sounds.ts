import type { PlaybackPayload } from './playback';
import { defaultBrainClient } from './client';

/** One sound of the library, public fields only. */
export interface SoundItem {
  readonly id: string;
  readonly name: string;
  readonly family: string;
  readonly familyLabel: string;
  /** Human label of the sound's type ("Acoustic piano", "Electronic"). */
  readonly type: string;
  /** Genres it suits (main first). */
  readonly styles: readonly string[];
  readonly bpm: number | null;
  readonly key: string | null;
  /** How it can be heard: a generated pattern (tonal), its audio file, or not yet. */
  readonly preview: 'pattern' | 'sample' | 'none';
  /** The track kind it can go on in a song, or null (drum hits, loops, fx, orchestral). */
  readonly useAs: 'keys' | 'bass' | 'pad' | 'pluckedSynths' | 'synths' | 'guitar' | 'popStrings' | 'popBrass' | null;
  /** Drum hits: the kit's drums it can replace (engine roles, e.g. snareDrum1). */
  readonly drumRoles: readonly string[];
}

/** What the engine applies when this sound plays, public facts only. */
export interface SoundDetails {
  /** The style the values are for (null: none applies). */
  readonly genre: string | null;
  readonly volumeDb: number | null;
  readonly octaveShift: number | null;
  readonly loudness: string;
  readonly bus: string | null;
  readonly inserts: readonly string[];
  readonly sends: { readonly reverb: number | null; readonly delay: number | null; readonly chorus: number | null };
  readonly bpm: number | null;
  readonly key: string | null;
  readonly notes: readonly string[];
}

export interface SoundFamily {
  readonly id: string;
  readonly label: string;
  readonly group: 'Instruments' | 'Drum hits' | 'Loops & breaks' | 'FX';
  readonly count: number;
}

export interface SoundList {
  readonly total: number;
  readonly items: readonly SoundItem[];
  readonly nextCursor: number | null;
  /** With `suits`: none of the sounds is tagged with the song's style, so all are listed. */
  readonly noneTagged?: boolean;
}

export const soundsQueryKeys = {
  families: ['sounds', 'families'] as const,
  list: (source: string, q: string, style: string) => ['sounds', 'list', source, q, style] as const,
  item: (id: string) => ['sounds', 'item', id] as const,
};

export const soundsApi = {
  families: (signal?: AbortSignal) =>
    defaultBrainClient.get<{ families: SoundFamily[]; transitions: { type: string; label: string; count: number }[] }>('/api/sounds/families', { signal }),
  list: (
    p: ({ family: string } | { useAs: string } | { transition: string }) & { q: string; style: string; suits?: string | undefined; cursor: number; limit?: number },
    signal?: AbortSignal,
  ) => {
    const qs = new URLSearchParams({ cursor: String(p.cursor), limit: String(p.limit ?? 60) });
    if ('family' in p) qs.set('family', p.family);
    else if ('useAs' in p) qs.set('useAs', p.useAs);
    else qs.set('transition', p.transition);
    if (p.q) qs.set('q', p.q);
    if (p.style) qs.set('style', p.style);
    if (p.suits) qs.set('suits', p.suits);
    return defaultBrainClient.get<SoundList>(`/api/sounds?${qs}`, { signal });
  },
  get: (id: string, signal?: AbortSignal) => defaultBrainClient.get<SoundItem>(`/api/sounds/${encodeURIComponent(id)}`, { signal }),
  /** A short pattern played by this sound alone (tonal sounds). */
  preview: (
    id: string,
    opts: { genre?: string | undefined; variant?: number; prefer?: string | undefined; keep?: { soundId: string; genre: string; variant: number } | undefined },
    signal?: AbortSignal,
  ) =>
    defaultBrainClient.post<PlaybackPayload & { bpm: number; bars: number; genre: string; genres: string[]; variant: number; kept: boolean; writer: string; loop: boolean }>(
      `/api/sounds/${encodeURIComponent(id)}/preview`,
      { ...(opts.genre ? { genre: opts.genre } : {}), ...(opts.prefer ? { prefer: opts.prefer } : {}), ...(opts.variant ? { variant: opts.variant } : {}), ...(opts.keep ? { keep: opts.keep } : {}) },
      { signal },
    ),
  /** What the engine applies to the sound (volume, octave, effects) and facts about it. */
  details: (id: string, genre: string | undefined, signal?: AbortSignal) =>
    defaultBrainClient.get<SoundDetails>(`/api/sounds/${encodeURIComponent(id)}/details${genre ? `?genre=${encodeURIComponent(genre)}` : ''}`, { signal }),
};
