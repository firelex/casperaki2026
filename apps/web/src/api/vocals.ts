import type { Song } from '@casperaki/song-schema';

import { defaultBrainClient } from './client';

/** Sung vocals (the brain's /api/vocals, docs/superpowers/specs/2026-11-24-sung-vocals-design.md). */
export interface VocalVoice {
  readonly id: string;
  readonly label: string;
  /** The voice's own range (MIDI): each track is sung at the octave nearest its median. */
  readonly median: number;
}

/** unused: a take left on a section that no longer has vocal notes (it is dropped before playing). */
/** sung: a take for the section as it is exists; unsung: none yet; none: no lead vocal notes. */
export type SectionState = 'none' | 'sung' | 'unsung';
export interface SectionStatus {
  readonly segment: string;
  readonly state: SectionState;
}

export const vocalsApi = {
  voices: (signal?: AbortSignal) => defaultBrainClient.get<{ voices: VocalVoice[] }>('/api/vocals/voices', { signal }).then((r) => r.voices),
  /** Every sung vocal track's sections (tracks with a setting), by track name. */
  status: (song: Song, signal?: AbortSignal) => defaultBrainClient.post<{ tracks: Record<string, SectionStatus[]> }>('/api/vocals/status', { song }, { signal }),
  /** Sings one section (nothing to do if its take is stored); slow: seconds per section. */
  sing: (song: Song, segment: string, track: string, signal?: AbortSignal) => defaultBrainClient.post<{ section: SectionStatus }>('/api/vocals/sing', { song, segment, track }, { signal }),
};
