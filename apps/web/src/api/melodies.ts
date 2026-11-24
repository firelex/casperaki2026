import { defaultBrainClient } from './client';

/** The two kinds of the melody library: our own hooks, and the legacy banks (remix patterns). */
export type MelodyKind = 'hooks' | 'remix';

/** One entry of the list. Pitches are sung pitch (the brain lifts the banks' octave-low register by 12). */
export interface MelodyListItem {
  readonly bank: string;
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly tempo: number;
  readonly tempoMin?: number;
  readonly tempoMax?: number;
  readonly feel?: string;
  /** Bars including a lead-in bar. */
  readonly bars: number;
  readonly lowestNote: number;
  readonly highestNote: number;
  readonly busyness: number;
}

export interface MelodyList {
  readonly total: number;
  readonly items: readonly MelodyListItem[];
  /** Hooks: the hooks bank has not been written yet. */
  readonly noHooksYet?: true;
  readonly facets: { readonly types: readonly string[]; readonly banks: readonly string[]; readonly feels: readonly string[] };
}

/** One entry: notes in beats from the start, sung pitch; one chord per half bar. */
export interface MelodyEntry extends MelodyListItem {
  readonly leadInBars: number;
  readonly melody: readonly { beat: number; midi: number; duration: number }[];
  readonly chords: readonly string[];
}

export interface MelodyFilters {
  readonly kind: MelodyKind;
  readonly bank: string;
  readonly type: string;
  readonly feel: string;
  /** bpm, or undefined for any tempo. */
  readonly tempo: number | undefined;
  readonly q: string;
}

export const MELODY_PAGE = 100;

/** The list request's query string: empty filters are left out. */
export function melodyListQuery(f: MelodyFilters, offset: number, limit = MELODY_PAGE): string {
  const qs = new URLSearchParams({ kind: f.kind, offset: String(offset), limit: String(limit) });
  if (f.bank) qs.set('bank', f.bank);
  if (f.type) qs.set('type', f.type);
  if (f.feel) qs.set('feel', f.feel);
  if (f.tempo !== undefined) qs.set('tempo', String(f.tempo));
  if (f.q) qs.set('q', f.q);
  return qs.toString();
}

export const melodiesApi = {
  list: (f: MelodyFilters, offset: number, signal?: AbortSignal) =>
    defaultBrainClient.get<MelodyList>(`/api/melody-library?${melodyListQuery(f, offset)}`, { signal }),
  entry: (bank: string, id: string, signal?: AbortSignal) =>
    defaultBrainClient.get<MelodyEntry>(`/api/melody-library/${encodeURIComponent(bank)}/${encodeURIComponent(id)}`, { signal }),
};
