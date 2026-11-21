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

interface ProposalBase {
  readonly id: string;
  readonly family: 'drums';
  readonly name: string;
  readonly genres: Genre[];
  readonly rationale: string;
  readonly review: PatternReview | null;
  /** Exported into the pattern library (bank-index.json). */
  readonly inLibrary: boolean;
}

export type PatternProposal =
  | (ProposalBase & { readonly kind: 'blueprints'; readonly blueprints: DrumBlueprint[] })
  | (ProposalBase & { readonly kind: 'algo'; readonly algo: string });

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
