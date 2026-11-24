import type { SuggestionComment } from '../components/SuggestionComments';
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
  /** Virtual Guitarist effect samples: [beat, fx1 | fx2 | fx4 | fx6]. */
  readonly fx?: ReadonlyArray<readonly [number, string]>;
}

export type LaneFamily = 'keys' | 'pad' | 'popStrings' | 'popBrass' | 'synths' | 'pluckedSynths';

interface ProposalBase {
  readonly id: string;
  readonly name: string;
  readonly genres: Genre[];
  readonly rationale: string;
  readonly review: PatternReview | null;
  /** Comments left on it, oldest first (Comment, besides Approve / Reject). */
  readonly comments: readonly SuggestionComment[];
  /** Exported into the pattern library (bank-index.json). */
  readonly inLibrary: boolean;
}

export type PatternProposal =
  | (ProposalBase & { readonly family: 'drums'; readonly kind: 'blueprints'; readonly blueprints: DrumBlueprint[] })
  | (ProposalBase & { readonly family: 'drums'; readonly kind: 'algo'; readonly algo: string })
  | (ProposalBase & { readonly family: 'bass'; readonly kind: 'bassPatterns'; readonly patterns: BassHit[][] })
  | (ProposalBase & { readonly family: LaneFamily; readonly kind: 'chordTones'; readonly patterns: ChordTonePattern[] })
  | (ProposalBase & { readonly family: 'guitar'; readonly kind: 'guitarPicks'; readonly patterns: GuitarPickPattern[] });

/** A section of a preview song: where it plays (seconds) and how full it is (verses low, choruses high). */
export interface PreviewSection {
  readonly name: string;
  readonly energy: 'low' | 'high' | null;
  readonly start: number;
  readonly end: number;
  /** The proposal's instrument has notes here (solo has something to play). */
  readonly plays: boolean;
}

export const patternsApi = {
  list: (signal?: AbortSignal) => defaultBrainClient.get<{ proposals: PatternProposal[] }>('/api/patterns', { signal }),
  comment: (id: string, body: string) =>
    defaultBrainClient.post<{ comment: SuggestionComment }>(`/api/patterns/${encodeURIComponent(id)}/comments`, { body }),
  review: (id: string, status: 'approved' | 'rejected' | 'pending', note: string) =>
    defaultBrainClient.post<{ review: PatternReview | null; /** What the decision changed in the pattern library (committed to git); null when the brain does not publish it. */ library: string[] | null }>(`/api/patterns/${encodeURIComponent(id)}/review`, { status, note }),
  /** `soundId`: play the proposal's instrument with this sound (undefined: the song's own). */
  /** The same decision for many proposals (one library export and commit). */
  reviewMany: (ids: readonly string[], status: 'approved' | 'rejected' | 'pending') =>
    defaultBrainClient.post<{ reviews: Record<string, PatternReview | null>; library: string[] | null }>('/api/patterns/review', { ids, status }),
  preview: (id: string, genre: Genre, variant: 'proposal' | 'current', take: number | undefined, soundId: string | undefined, signal?: AbortSignal) =>
    defaultBrainClient.post<
      PlaybackPayload & {
        seed: string;
        /** Tracks playing the proposal's instrument. */
        lanes: string[];
        sections: PreviewSection[];
        /** The sound the instrument plays (null: not a library sound). */
        soundId: string | null;
      }
    >(
      `/api/patterns/${encodeURIComponent(id)}/preview`,
      { genre, variant, ...(take === undefined ? {} : { take }), ...(soundId ? { soundId } : {}) },
      { signal },
    ),
  /** Save the song a preview with these settings plays as a new project; its id (Open in editor). */
  project: (id: string, genre: Genre, variant: 'proposal' | 'current', take: number | undefined, soundId: string | undefined) =>
    defaultBrainClient.post<{ id: string }>(`/api/patterns/${encodeURIComponent(id)}/project`, {
      genre,
      variant,
      ...(take === undefined ? {} : { take }),
      ...(soundId ? { soundId } : {}),
    }),
  /** The sounds the proposal's instrument can use in `genre` (the instrument picker; none for drums). */
  sounds: (id: string, genre: Genre, signal?: AbortSignal) =>
    defaultBrainClient.get<{ sounds: { id: string; name: string; /** In the genre's own pool (what generated songs pick from). */ inStyle: boolean }[] }>(`/api/patterns/${encodeURIComponent(id)}/sounds?genre=${genre}`, { signal }),
};

export const patternsQueryKey = ['patterns'] as const;
