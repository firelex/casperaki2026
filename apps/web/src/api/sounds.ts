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
  readonly preview: 'pattern' | 'audio' | 'none';
  /** The track kind it can go on in a song, or null (drum hits, loops, fx, orchestral). */
  readonly useAs: 'keys' | 'bass' | 'pad' | 'pluckedSynths' | 'synths' | 'guitar' | 'popStrings' | 'popBrass' | null;
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
}

export const soundsQueryKeys = {
  families: ['sounds', 'families'] as const,
  list: (family: string, q: string, style: string) => ['sounds', 'list', family, q, style] as const,
  item: (id: string) => ['sounds', 'item', id] as const,
};

export const soundsApi = {
  families: (signal?: AbortSignal) => defaultBrainClient.get<{ families: SoundFamily[] }>('/api/sounds/families', { signal }),
  list: (p: { family: string; q: string; style: string; cursor: number; limit?: number }, signal?: AbortSignal) => {
    const qs = new URLSearchParams({ family: p.family, cursor: String(p.cursor), limit: String(p.limit ?? 60) });
    if (p.q) qs.set('q', p.q);
    if (p.style) qs.set('style', p.style);
    return defaultBrainClient.get<SoundList>(`/api/sounds?${qs}`, { signal });
  },
  get: (id: string, signal?: AbortSignal) => defaultBrainClient.get<SoundItem>(`/api/sounds/${encodeURIComponent(id)}`, { signal }),
  /** A short pattern played by this sound alone (tonal sounds). */
  preview: (id: string, opts: { genre?: string; variant?: number }, signal?: AbortSignal) =>
    defaultBrainClient.post<PlaybackPayload & { bpm: number; bars: number; genre: string; genres: string[]; variant: number }>(
      `/api/sounds/${encodeURIComponent(id)}/preview`,
      { ...(opts.genre ? { genre: opts.genre } : {}), ...(opts.variant ? { variant: opts.variant } : {}) },
      { signal },
    ),
  audioUrl: (id: string) => `/api/sounds/${encodeURIComponent(id)}/audio`,
};
