import type { Song } from '@casperaki/song-schema';
import { defaultBrainClient } from './client';

/** One sample the browser engine needs: fetch `url` (an OGG), decode, bind
 *  under `key`. Fret noises are slice `index` of `count` equal slices. */
export interface PlaybackSample {
  readonly key: string;
  readonly kind: 'tonal' | 'drum' | 'wave' | 'fret' | 'strum';
  readonly url: string;
  readonly index?: number;
  readonly count?: number;
}

/** Everything the WASM engine needs to play a song in the browser. */
export interface PlaybackPayload {
  readonly songId: string;
  /** song.json text (the engine's input). */
  readonly song: string;
  /** inst-N.json texts, ascending id order. */
  readonly insts: string[];
  readonly samples: PlaybackSample[];
  /** The engine's five fallback samples, role order kick, snare, hat, tone, bass. */
  readonly stubs: string[];
}

export const playbackApi = {
  /** A saved song the user owns. */
  forSaved: (songId: string, signal?: AbortSignal) =>
    defaultBrainClient.get<PlaybackPayload>(`/api/songs/${encodeURIComponent(songId)}/playback`, { signal }),
  /** Any song, e.g. the editor's working copy with unsaved edits. */
  forSong: (song: Song, signal?: AbortSignal) =>
    defaultBrainClient.post<PlaybackPayload>('/api/playback', { song }, { signal }),
};
