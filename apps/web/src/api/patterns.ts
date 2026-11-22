import type { Genre } from '@casperaki/song-schema/schemas';

import { defaultBrainClient } from './client';
import type { PlaybackPayload } from './playback';

export type DrumBlueprint = Readonly<Record<string, readonly number[]>>;

export interface PatternReview {
  readonly proposalId: string;
  readonly status: 'approved' | 'rejected';
  readonly note: string;
  readonly reviewer: string;
  readonly decidedAt: string;
}

/** [beat position, length in beats, semitones from the chord root] */
export type BassHit = readonly [number, number, number];

export type Energy = 'low' | 'high';

/** Notes in semitones from middle C, written over C major: [beat, semitones, length]. */
export interface ChordTonePattern {
  readonly bars: number;
  readonly energy?: Energy;
  readonly notes: ReadonlyArray<readonly [number, number, number]>;
}

/** Strings of the chord shape (0 = lowest): [beat, strings, length, velocity]. */
export interface GuitarPickPattern {
  readonly bars: number;
  readonly energy?: Energy;
  readonly hits: ReadonlyArray<readonly [number, readonly number[], number, number]>;
}

export type LaneFamily = 'keys' | 'pad' | 'popStrings' | 'popBrass' | 'synths' | 'pluckedSynths';

interface ProposalBase {
  readonly id: string;
  readonly name: string;
  readonly genres: Genre[];
  readonly rationale: string;
  readonly review: PatternReview | null;
  /** Exported into the pattern library (bank-index.json). */
  readonly inLibrary: boolean;
}

export type PatternProposal =
  | (ProposalBase & { readonly family: 'drums'; readonly kind: 'blueprints'; readonly blueprints: DrumBlueprint[] })
  | (ProposalBase & { readonly family: 'drums'; readonly kind: 'algo'; readonly algo: string })
  | (ProposalBase & { readonly family: 'bass'; readonly kind: 'bassPatterns'; readonly patterns: BassHit[][] })
  | (ProposalBase & { readonly family: LaneFamily; readonly kind: 'chordTones'; readonly patterns: ChordTonePattern[] })
  | (ProposalBase & { readonly family: 'guitar'; readonly kind: 'guitarPicks'; readonly patterns: GuitarPickPattern[] });

export const patternsApi = {
  list: (signal?: AbortSignal) => defaultBrainClient.get<{ proposals: PatternProposal[] }>('/api/patterns', { signal }),
  review: (id: string, status: 'approved' | 'rejected' | 'pending', note: string) =>
    defaultBrainClient.post<{ review: PatternReview | null }>(`/api/patterns/${encodeURIComponent(id)}/review`, { status, note }),
  preview: (id: string, genre: Genre, variant: 'proposal' | 'current', signal?: AbortSignal) =>
    defaultBrainClient.post<PlaybackPayload & { seed: string }>(
      `/api/patterns/${encodeURIComponent(id)}/preview`,
      { genre, variant },
      { signal },
    ),
};

export const patternsQueryKey = ['patterns'] as const;
