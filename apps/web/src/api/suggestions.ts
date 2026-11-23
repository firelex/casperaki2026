import { defaultBrainClient } from './client';

/** One kind of Pro-mode change, with every song's value (GET /api/suggestions/mix). */
export interface MixChange {
  readonly kind: 'volume' | 'send' | 'plugin';
  /** volume / send: the instrument type; plugin: the FX bus. */
  readonly target: string;
  readonly detail?: { readonly send?: 'reverb' | 'delay' | 'chorus'; readonly plugin?: string; readonly slot?: number; readonly param?: number };
  readonly standard: number;
  readonly average: number;
  readonly values: readonly { readonly value: number; readonly songId: string; readonly title: string; readonly lane?: string; readonly updatedAt: string }[];
}

export interface GenreMixSuggestions {
  readonly genre: string;
  /** Songs with a Pro-mode mix in this genre. */
  readonly songs: number;
  readonly changes: readonly MixChange[];
}

export const suggestionsApi = {
  mix: (signal?: AbortSignal) => defaultBrainClient.get<{ genres: GenreMixSuggestions[] }>('/api/suggestions/mix', { signal }),
};
