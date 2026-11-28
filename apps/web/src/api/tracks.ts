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
  | { readonly kind: 'addTrack'; readonly family: InstrumentFamily; readonly segments: readonly string[]; readonly soundId?: string }
  /** Replace one drum of the kit (null: back to the style's own). */
  | { readonly kind: 'setDrumSound'; readonly role: string; readonly soundId: string | null }
  /** A new melody (with its chords and the parts under it) for every section of this section's type. */
  | { readonly kind: 'newMelody'; readonly section: string }
  /** The vocal tracks show the melody the generator chose (a new song's vocal tracks start empty). */
  | { readonly kind: 'writeMelody' }
  /** Written lyrics (section → lines) on the vocal tracks: a finished Write lyrics task merged into unsaved edits. */
  | { readonly kind: 'applyLyrics'; readonly lyrics: Readonly<Record<string, readonly string[]>> }
  | { readonly kind: 'applyLyricsFirst'; readonly lyrics: Readonly<Record<string, readonly string[]>> }
  | { readonly kind: 'newRhythm'; readonly section: string }
  /** A finished ACE layer task's result (the apply response's `result`): its clips on their "ACE <Instrument>" track. */
  | { readonly kind: 'applyAceLayer'; readonly result: unknown }
  /** The rap's words of some sections (section → lines): a finished Write rap lyrics task merged into unsaved edits. */
  | { readonly kind: 'setRapLyrics'; readonly lyrics: Readonly<Record<string, readonly string[]>> }
  /** Every take of a track in a section muted or unmuted (right-click a clip). */
  | { readonly kind: 'setTakesMuted'; readonly track: string; readonly segment: string; readonly muted: boolean }
  /** A finished Sing task's result (the apply response's `result`) put into the working copy. */
  | {
      readonly kind: 'applySung';
      readonly result: unknown;
      /** The saved version: its take fingerprints are kept. */
      readonly sungOver: Song;
      /** The result covers only its melody's sections (Transcribe melody): other sections keep their takes. */
      readonly partial?: boolean;
    };

export type TransitionPlacement = 'beginningOfSegment' | 'midSegment' | 'endOfSegment';

export interface TransitionState {
  readonly types: readonly { readonly type: string; readonly label: string; readonly placements: readonly TransitionPlacement[]; readonly swappable: boolean }[];
  readonly sections: Readonly<
    Record<string, readonly { readonly type: string; readonly placement: TransitionPlacement; readonly soundId: string | null; readonly soundName: string | null }[]>
  >;
}

/** One drum of the song's kit: its part (engine role), label, library family and sound. */
export interface DrumKitRow {
  readonly role: string;
  readonly label: string;
  readonly family: string;
  readonly soundId: string | null;
  readonly name: string | null;
  /** Replaced by the user (not the style's own). */
  readonly overridden: boolean;
}

export const tracksApi = {
  options: (song: Song, signal?: AbortSignal) =>
    defaultBrainClient.post<TrackOptions>('/api/tracks/options', { song }, { signal }),
  /** The brain rewrites one track with the generator and returns the whole song. */
  /** `songId`: the saved project the song belongs to; the brain refuses Write melody / New melody while it is being sung. */
  edit: (song: Song, op: TrackEdit, signal?: AbortSignal, songId?: string) =>
    defaultBrainClient.post<{ song: Song; track: string }>('/api/tracks/edit', { song, op, ...(songId !== undefined ? { songId } : {}) }, { signal }),
  /** Switch a transition on or off in sections (the brain writes snare-roll grids). */
  setTransition: (
    song: Song,
    op: { segments: readonly string[]; type: string; placement: TransitionPlacement; on: boolean; soundId?: string },
    signal?: AbortSignal,
  ) => defaultBrainClient.post<{ song: Song }>('/api/transitions/set', { song, ...op }, { signal }),
  /** Every section's transitions with the sound each plays, and the transition types. */
  transitionState: (song: Song, signal?: AbortSignal) => defaultBrainClient.post<TransitionState>('/api/transitions/state', { song }, { signal }),
  /** A preview song's sung track played on a piano (the engine does not sing yet). */
  vocalAsPiano: (song: Song, track: string, signal?: AbortSignal) =>
    defaultBrainClient.post<{ song: Song; pianoName: string }>('/api/tracks/vocal-as-piano', { song, track }, { signal }),
  /** The drums of the song's kit and the sound each plays. */
  drumKit: (song: Song, signal?: AbortSignal) => defaultBrainClient.post<{ kit: DrumKitRow[] }>('/api/tracks/drum-kit', { song }, { signal }),
  /** A new section written by the generator, inserted at `index` (0 = first). */
  addSection: (song: Song, type: string, index: number, bars?: number, signal?: AbortSignal) =>
    defaultBrainClient.post<{ song: Song; name: string }>('/api/sections/add', { song, type, index, ...(bars ? { bars } : {}) }, { signal }),
};
