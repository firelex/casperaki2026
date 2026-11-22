import type { Song } from '@casperaki/song-schema';
import { defaultBrainClient } from './client';

/** Instrument families the generator can write a part for. */
export type InstrumentFamily =
  | 'drums' | 'bass' | 'keys' | 'pad' | 'guitar' | 'synths' | 'pluckedSynths' | 'popStrings' | 'popBrass';

export interface TrackSound {
  readonly id: string;
  /** Public name of the sound. */
  readonly name: string;
}

export interface TrackOptions {
  /** Per track in the song: its family, current sound, and whether the
   *  generator can rewrite it (vocals, transitions and loops it can't). */
  readonly tracks: Record<string, { readonly family: InstrumentFamily | null; readonly soundId: string | null; readonly editable: boolean }>;
  /** The sounds this song's genre offers, per family. Drums list none: the
   *  kit is built per genre, so only its pattern can change. */
  readonly families: readonly { readonly family: InstrumentFamily; readonly label: string; readonly sounds: readonly TrackSound[] }[];
}

export type TrackEdit =
  | { readonly kind: 'changeSound'; readonly track: string; readonly soundId: string }
  | { readonly kind: 'newPattern'; readonly track: string }
  | { readonly kind: 'addTrack'; readonly family: InstrumentFamily; readonly segments: readonly string[]; readonly soundId?: string };

export const tracksApi = {
  options: (song: Song, signal?: AbortSignal) =>
    defaultBrainClient.post<TrackOptions>('/api/tracks/options', { song }, { signal }),
  /** The brain rewrites one track with the generator and returns the whole song. */
  edit: (song: Song, op: TrackEdit, signal?: AbortSignal) =>
    defaultBrainClient.post<{ song: Song; track: string }>('/api/tracks/edit', { song, op }, { signal }),
  /** A new section written by the generator, inserted at `index` (0 = first). */
  addSection: (song: Song, type: string, index: number, bars?: number, signal?: AbortSignal) =>
    defaultBrainClient.post<{ song: Song; name: string }>('/api/sections/add', { song, type, index, ...(bars ? { bars } : {}) }, { signal }),
};
