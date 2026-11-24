import type { AIArtifact, Song } from '@casperaki/song-schema';

import { defaultBrainClient } from './client';

/** Sung vocals (the brain's /api/vocals, docs/superpowers/specs/2026-11-24-sung-vocals-design.md). */
export interface VocalVoice {
  readonly id: string;
  readonly label: string;
  /** Semitones every sung note moves by (male voices sing the written line an octave down). */
  readonly octave: number;
}

export type SectionState = 'none' | 'current' | 'stale' | 'missing';
export interface SectionStatus {
  readonly segment: string;
  readonly state: SectionState;
}

export const vocalsApi = {
  voices: (signal?: AbortSignal) => defaultBrainClient.get<{ voices: VocalVoice[] }>('/api/vocals/voices', { signal }).then((r) => r.voices),
  status: (song: Song, signal?: AbortSignal) => defaultBrainClient.post<{ sections: SectionStatus[] }>('/api/vocals/status', { song }, { signal }),
  /** Sings one section (or reuses its stored take); slow: seconds per section. */
  sing: (song: Song, segment: string, signal?: AbortSignal) => defaultBrainClient.post<{ artifact: AIArtifact }>('/api/vocals/sing', { song, segment }, { signal }),
};
