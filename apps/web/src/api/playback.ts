import type { MixOverrides, Song } from '@casperaki/song-schema';

import type { MixConfigJson } from '../audio/livePlayer';
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
  /** mix-config.json text: the per-lane mix and rack FX, as on the server. */
  readonly mixConfig: string;
  /** The standard mix's FX bus chains (before the song's Pro-mode changes). */
  readonly standardRackChains: MixConfigJson['rackChains'];
  /** The song version: its text and the mix config it plays with (the brain's render/songVersion.ts). */
  readonly versionKey: string;
  /** A genre recipe's mastering reference (Casperaki Pop), mastered towards instead of Atemlos. */
  readonly masteringReference?: MasteringReference;
}

/** A mastering reference (the brain's data/mastering-references, casperaki_master_reference's output). */
export interface MasteringReference {
  readonly rms: number;
  readonly peak: number;
  readonly mid: readonly number[];
  readonly side: readonly number[];
}

export const playbackApi = {
  /** A saved song the user owns. */
  forSaved: (songId: string, signal?: AbortSignal) =>
    defaultBrainClient.get<PlaybackPayload>(`/api/songs/${encodeURIComponent(songId)}/playback`, { signal }),
  /** Any song, e.g. the editor's working copy with unsaved edits. */
  forSong: (song: Song, signal?: AbortSignal, mixOverrides?: MixOverrides) =>
    defaultBrainClient.post<PlaybackPayload>('/api/playback', { song, ...(mixOverrides ? { mixOverrides } : {}) }, { signal }),
};
