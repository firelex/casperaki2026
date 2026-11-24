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
  /** Hooks: the song style it was written for (a genre id). */
  readonly style?: string;
  /** Hooks: the narrower style within it (e.g. disco). */
  readonly substyle?: string;
  /** Bars including a lead-in bar. */
  readonly bars: number;
  readonly lowestNote: number;
  readonly highestNote: number;
  readonly busyness: number;
  /** Highest minus lowest note, in semitones. */
  readonly range: number;
  readonly source: MelodySource;
  /** Used whole, exactly as written. */
  readonly useOriginal: boolean;
  /** Used in mixing (rhythm of one entry, shape and chords of another). */
  readonly useRemix: boolean;
  readonly edited: boolean;
  readonly editedAt?: string;
  readonly editedBy?: string;
}

export interface MelodySource {
  readonly kind: 'song' | 'casperaki';
  readonly title?: string;
  readonly artist?: string;
}

export type MelodyRange = 'narrow' | 'medium' | 'wide';

export interface MelodyList {
  readonly total: number;
  readonly items: readonly MelodyListItem[];
  /** Hooks: the hooks bank has not been written yet. */
  readonly noHooksYet?: true;
  readonly facets: { readonly types: readonly string[]; readonly sources: readonly MelodySource['kind'][]; readonly feels: readonly string[]; readonly styles: readonly string[]; readonly substyles: readonly string[] };
}

/** One entry: notes in beats from the start, sung pitch; one chord per half bar. */
export interface MelodyEntry extends MelodyListItem {
  readonly leadInBars: number;
  readonly melody: readonly { beat: number; midi: number; duration: number }[];
  readonly chords: readonly string[];
}

export interface MelodyFilters {
  readonly kind: MelodyKind;
  readonly source: MelodySource['kind'] | '';
  readonly range: MelodyRange | '';
  readonly type: string;
  readonly feel: string;
  /** Hooks: a style (genre id), 'none' for hooks without one, '' for any. */
  readonly style: string;
  /** Hooks: a substyle, '' for any. */
  readonly substyle: string;
  /** bpm, or undefined for any tempo. */
  readonly tempo: number | undefined;
  readonly q: string;
  /** Only entries with the flag on / off ('' = either). */
  readonly original: 'on' | 'off' | '';
  readonly remix: 'on' | 'off' | '';
}

/** What Save sends: the whole edited entry at sung pitch, one chord per half bar. */
export interface MelodySave {
  readonly melody: readonly { beat: number; midi: number; duration: number }[];
  readonly chords: readonly string[];
  readonly artist: string;
  readonly useOriginal: boolean;
  readonly useRemix: boolean;
}

export const MELODY_PAGE = 100;

/** The list request's query string: empty filters are left out. */
export function melodyListQuery(f: MelodyFilters, offset: number, limit = MELODY_PAGE): string {
  const qs = new URLSearchParams({ kind: f.kind, offset: String(offset), limit: String(limit) });
  if (f.source) qs.set('source', f.source);
  if (f.range) qs.set('range', f.range);
  if (f.type) qs.set('type', f.type);
  if (f.feel) qs.set('feel', f.feel);
  if (f.style) qs.set('style', f.style);
  if (f.substyle) qs.set('substyle', f.substyle);
  if (f.tempo !== undefined) qs.set('tempo', String(f.tempo));
  if (f.original) qs.set('original', f.original === 'on' ? '1' : '0');
  if (f.remix) qs.set('remix', f.remix === 'on' ? '1' : '0');
  if (f.q) qs.set('q', f.q);
  return qs.toString();
}

export const melodiesApi = {
  list: (f: MelodyFilters, offset: number, signal?: AbortSignal) =>
    defaultBrainClient.get<MelodyList>(`/api/melody-library?${melodyListQuery(f, offset)}`, { signal }),
  entry: (bank: string, id: string, signal?: AbortSignal) =>
    defaultBrainClient.get<MelodyEntry>(entryPath(bank, id), { signal }),
  /** Saves the edit; a refused one throws a BrainError whose body has `problems` (in words). */
  save: (bank: string, id: string, body: MelodySave) => defaultBrainClient.put<MelodyEntry>(entryPath(bank, id), body),
  /** Back to the stored version. */
  revert: (bank: string, id: string) => defaultBrainClient.delete<MelodyEntry>(`${entryPath(bank, id)}/edit`),
  /** Every chord the fitter knows, ranked for one half bar of the melody (key C). */
  chordOptions: (melody: MelodySave['melody'], bars: number, slot: number) =>
    defaultBrainClient.post<{ options: { chord: string; fit: number }[] }>('/api/melody-library/chord-options', { melody, bars, slot }).then((r) => r.options),
};

const entryPath = (bank: string, id: string) => `/api/melody-library/${encodeURIComponent(bank)}/${encodeURIComponent(id)}`;

/** Where an entry comes from, in words: "Song section · Titanium", "Casperaki original". */
export function sourceLabel(s: MelodySource): string {
  if (s.kind === 'casperaki') return 'Casperaki original';
  return s.title ? `Song section · ${s.title}` : 'Song section';
}

/** The range filter's band of a range in semitones (narrow up to 9, medium 10-14, wide 15 and more). */
export const rangeBand = (semitones: number): MelodyRange => (semitones <= 9 ? 'narrow' : semitones <= 14 ? 'medium' : 'wide');
