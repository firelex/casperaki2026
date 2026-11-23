import type { SuggestionComment } from '../components/SuggestionComments';
import { defaultBrainClient } from './client';

/** One kind of Pro-mode change, with every song's value (GET /api/suggestions/mix). */
export interface MixChange {
  /** Identifies the change within its genre (for Delete). */
  readonly key: string;
  readonly kind: 'volume' | 'send' | 'plugin';
  /** volume / send: the instrument type; plugin: the FX bus. */
  readonly target: string;
  readonly detail?: { readonly send?: 'reverb' | 'delay' | 'chorus'; readonly plugin?: string; readonly slot?: number; readonly param?: number };
  readonly standard: number;
  readonly average: number;
  readonly values: readonly { readonly value: number; readonly songId: string; readonly title: string; readonly lane?: string; readonly updatedAt: string }[];
  /** Comments left on this change, oldest first. */
  readonly comments: readonly SuggestionComment[];
}

export interface GenreMixSuggestions {
  readonly genre: string;
  /** Songs with a change listed here. */
  readonly songs: number;
  readonly changes: readonly MixChange[];
}

export const suggestionsApi = {
  mix: (signal?: AbortSignal) => defaultBrainClient.get<{ genres: GenreMixSuggestions[] }>('/api/suggestions/mix', { signal }),
  commentMix: (genre: string, key: string, body: string) =>
    defaultBrainClient.post<{ comment: SuggestionComment }>('/api/suggestions/mix/comments', { genre, key, body }),
  /** Hide one change (the songs keep their mixes; a later change shows it again). */
  dismissMix: (genre: string, key: string) => defaultBrainClient.delete(`/api/suggestions/mix?${new URLSearchParams({ genre, key }).toString()}`),
};
