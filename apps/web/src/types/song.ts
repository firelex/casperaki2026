import { GENRE_RECIPES, type SongGenre } from '@casperaki/song-schema/genres';
import { GenreSchema } from '@casperaki/song-schema/schemas';
/**
 * Song view helpers.
 *
 * The workbench treats `@casperaki/song-schema` as the single source of
 * truth. This module derives the small, view-friendly projections each
 * inspector panel needs, so panel components stay declarative and don't
 * spelunk through `arrangement[seg].overrides[...].bars[...].notes`
 * inline.
 *
 * Vocabulary intentionally matches the canonical schema (see docs/20):
 *   - canonical genres: `brightPop`, `ballad`, `edm`, `latin`,
 *     `organicVibes`, `rock`, `schlager`, `urban` — no `pop` alias.
 *   - tonal instrument families: `Drums`, `Bass`, `Keys`, `Pad`,
 *     `Lead vocals`, `Backing vocals`.
 */

import type {
  Arrangement,
  Bar,
  Genre,
  InstrumentDefinition,
  NoteEvent,
  Segment,
  SegmentPayload,
  Song,
  SongStructure,
} from '@casperaki/song-schema';

/** The base genres, as the style picker shows them first. */
export const BASE_GENRES: readonly SongGenre[] = GenreSchema.options;
/** The genre recipes (Casperaki Pop), shown in a section of their own below the base genres (owner 2026-11-28). */
export const RECIPE_GENRES: readonly SongGenre[] = Object.keys(GENRE_RECIPES) as SongGenre[];
/** The genres a new song can have, in the order the tiles show them: the base genres, then the recipes. */
export const CANONICAL_GENRES: readonly SongGenre[] = [...BASE_GENRES, ...RECIPE_GENRES];

/** Instrument families the engine adapter currently understands. */
export const TONAL_FAMILIES = ['Drums', 'Bass', 'Keys', 'Pad'] as const;
/**
 * Brain emits a single lead `Vocal` slot plus numbered `Backing vocals N`
 * (see docs/53ah). The workbench treats these as the canonical names.
 */
export const LEAD_VOCAL_NAME = 'Vocal';
export const BACKING_VOCAL_PREFIX = 'Backing vocals';

export interface SegmentSummary {
  readonly name: string;
  readonly kind: string | undefined;
  readonly bars: number;
  readonly activeInstruments: readonly string[];
  readonly chordsByBar: readonly (readonly string[])[];
  readonly hasOverrides: boolean;
}

/**
 * Build per-segment summaries combining structure metadata with arrangement
 * presence — that's what the structure-timeline + harmony panels need.
 */
export function summarizeStructure(song: Song): readonly SegmentSummary[] {
  const arr: Arrangement = song.arrangement;
  return song.songStructure.map((segment: Segment) => {
    const payload = arr[segment.name];
    const instruments = payload?.instruments ?? {};
    const activeInstruments = Object.entries(instruments)
      .filter(([, on]) => on)
      .map(([name]) => name);
    const chordsByBar = segment.bars.map((bar) => bar.chords.map(String));
    return {
      name: segment.name,
      kind: segment.type ?? inferSegmentKind(segment.name),
      bars: segment.lengthInBars ?? segment.bars.length,
      activeInstruments,
      chordsByBar,
      hasOverrides: payload ? Object.keys(payload.overrides).length > 0 : false,
    };
  });
}

/** Cheap heuristic kind tag when the brain leaves `type` empty (matches docs/53z naming). */
function inferSegmentKind(name: string): string {
  const stripped = name.replace(/\d+$/u, '');
  return stripped || name;
}

export interface BarChordView {
  readonly bar: number;
  readonly chords: readonly string[];
}

export interface PatternBarSummary {
  readonly bar: number;
  /** Beat positions that carry events (e.g. ["0.0", "1.5"]). */
  readonly beats: readonly string[];
  readonly eventCount: number;
}

export interface InstrumentPatternSummary {
  readonly instrument: string;
  readonly type: string | undefined;
  /** Drum-pattern ASCII grids — present on `Drums` overrides. Keyed by drum slot. */
  readonly drumPattern: Readonly<Record<string, string>> | undefined;
  readonly bars: readonly PatternBarSummary[];
  readonly totalEvents: number;
}

/**
 * Per-segment instrument summary — answers "what's playing in chorus1?".
 * Empty arrays are intentional: an instrument toggled on without an
 * override should still appear in the inspector.
 */
export function summarizeSegmentPatterns(
  song: Song,
  segmentName: string,
): readonly InstrumentPatternSummary[] {
  const payload = song.arrangement[segmentName];
  if (!payload) return [];
  const overrides = payload.overrides ?? {};
  return Object.entries(overrides).map(([instrument, override]) => {
    const bars: PatternBarSummary[] = (override.bars ?? []).map((bar: Bar, idx) => {
      const notes = bar.notes ?? {};
      const beats = Object.keys(notes);
      const eventCount = beats.reduce(
        (sum, beat) => sum + ((notes[beat as keyof typeof notes] as NoteEvent[] | undefined)?.length ?? 0),
        0,
      );
      return { bar: idx, beats, eventCount };
    });
    const totalEvents = bars.reduce((sum, b) => sum + b.eventCount, 0);
    return {
      instrument,
      type: override.type,
      drumPattern: override.pattern,
      bars,
      totalEvents,
    };
  });
}

export interface LyricLineView {
  readonly bar: number;
  readonly beat: string;
  readonly words: readonly string[];
  readonly endOfPhrase: boolean;
}

/**
 * Best-effort lyric extraction from the vocal override bars[].notes map.
 *
 * The vocal generator stores `fullWord` on vocal note events
 * (docs/53ai, docs/20). This helper walks the song-structure order and
 * returns one entry per beat that carries lyric text.
 */
export function extractLyricLines(
  song: Song,
  vocalInstrument: string = LEAD_VOCAL_NAME,
): readonly { readonly segment: string; readonly lines: readonly LyricLineView[] }[] {
  const out: { segment: string; lines: LyricLineView[] }[] = [];
  for (const segment of song.songStructure) {
    const override = song.arrangement[segment.name]?.overrides?.[vocalInstrument];
    if (!override?.bars) continue;
    const lines: LyricLineView[] = [];
    override.bars.forEach((bar, barIdx) => {
      const notes = bar.notes ?? {};
      for (const beat of Object.keys(notes)) {
        const events = notes[beat as keyof typeof notes] as NoteEvent[] | undefined;
        if (!events) continue;
        const words = events
          .map((ev) => (ev as { fullWord?: string }).fullWord)
          .filter((w): w is string => typeof w === 'string' && w.length > 0);
        const endOfPhrase = events.some((ev) => (ev as { endOfPhrase?: boolean }).endOfPhrase === true);
        if (words.length > 0 || endOfPhrase) {
          lines.push({ bar: barIdx, beat, words, endOfPhrase });
        }
      }
    });
    if (lines.length > 0) out.push({ segment: segment.name, lines });
  }
  return out;
}

/**
 * Discover backing-vocal track names actually used by a song.
 * Brain emits `Backing vocals 1`, `Backing vocals 2`, ... — whatever
 * names appear under arrangement overrides + instruments maps.
 */
export function findBackingVocalTracks(song: Song): readonly string[] {
  const seen = new Set<string>();
  for (const seg of Object.values(song.arrangement)) {
    for (const name of Object.keys(seg.instruments)) {
      if (name.startsWith(BACKING_VOCAL_PREFIX)) seen.add(name);
    }
    for (const name of Object.keys(seg.overrides)) {
      if (name.startsWith(BACKING_VOCAL_PREFIX)) seen.add(name);
    }
  }
  return [...seen].sort();
}

/** Count distinct chord symbols across the whole song. Surfaced in the song overview. */
export function distinctChordCount(structure: SongStructure): number {
  const set = new Set<string>();
  for (const seg of structure) {
    for (const bar of seg.bars) {
      for (const c of bar.chords) set.add(String(c));
    }
  }
  return set.size;
}

export interface GeneratorView {
  readonly name: string;
  readonly version: string;
  readonly seed: string;
  readonly genre: string;
  readonly key: string;
  readonly bpm: number;
}

export interface ChordProgressionView {
  /** Bar-aligned chord rows. Each row is the chords for one bar. */
  readonly bars: readonly (readonly string[])[];
  /** Unique chord symbols in first-appearance order. */
  readonly unique: readonly string[];
  /** Total chord-change count across the segment. */
  readonly totalChanges: number;
}

/** Compact summary of a segment's chord progression. Empty rows are preserved. */
export function summarizeChordProgression(segment: Segment): ChordProgressionView {
  const bars = segment.bars.map((bar) => bar.chords.map(String));
  const seen = new Set<string>();
  const unique: string[] = [];
  let totalChanges = 0;
  for (const row of bars) {
    for (const c of row) {
      totalChanges += 1;
      if (!seen.has(c)) {
        seen.add(c);
        unique.push(c);
      }
    }
  }
  return { bars, unique, totalChanges };
}

export interface BackingVocalPresence {
  readonly name: string;
  readonly active: boolean;
  readonly hasOverride: boolean;
  readonly lyricLineCount: number;
}

export interface SignalProcessorSummary {
  readonly instrument: string;
  readonly type: string | undefined;
  /** Parameter names with attached automation curves (e.g. `lowPassFilter`). */
  readonly parameters: readonly string[];
}

export interface FillSummary {
  readonly instrument: string;
  /** Fill pattern names (e.g. `patternFourthBar`). */
  readonly patternNames: readonly string[];
}

export interface SegmentDetail {
  readonly name: string;
  readonly kind: string | undefined;
  readonly bars: number;
  readonly active: boolean;
  /** Names from the `instruments` map that are toggled on. */
  readonly activeInstruments: readonly string[];
  readonly chordProgression: ChordProgressionView;
  /** Per-instrument override summaries — drums get the pattern grid. */
  readonly patterns: readonly InstrumentPatternSummary[];
  readonly leadVocalLines: readonly LyricLineView[];
  readonly backingVocals: readonly BackingVocalPresence[];
  readonly fills: readonly FillSummary[];
  /** Transition keys present (e.g. `Drums`, `Riser`). Opaque payload — we just count/list. */
  readonly transitions: readonly string[];
  /** Mute regions keyed by instrument. */
  readonly mutes: readonly string[];
  readonly signalProcessors: readonly SignalProcessorSummary[];
}

/**
 * Aggregate everything the Segment Inspector needs into a single
 * derived structure. Returns undefined when the segment isn't part of
 * the song's structure — callers render the empty state.
 */
export function buildSegmentDetail(
  song: Song,
  segmentName: string | undefined,
): SegmentDetail | undefined {
  if (!segmentName) return undefined;
  const segment = song.songStructure.find((s) => s.name === segmentName);
  if (!segment) return undefined;
  const payload: SegmentPayload | undefined = song.arrangement[segmentName];
  const instruments = payload?.instruments ?? {};
  const activeInstruments = Object.entries(instruments)
    .filter(([, on]) => on)
    .map(([name]) => name);

  const patterns = summarizeSegmentPatterns(song, segmentName);

  const leadVocalLines = extractSegmentLyricLines(payload, LEAD_VOCAL_NAME);
  const backingVocalNames = collectBackingVocalNames(payload, instruments);
  const backingVocals: BackingVocalPresence[] = backingVocalNames.map((name) => {
    const override = payload?.overrides?.[name];
    return {
      name,
      active: Boolean(instruments[name]),
      hasOverride: Boolean(override),
      lyricLineCount: extractSegmentLyricLines(payload, name).length,
    };
  });

  const fills: FillSummary[] = Object.entries(payload?.fills ?? {}).map(([instrument, block]) => ({
    instrument,
    patternNames: Object.keys(block?.patterns ?? {}),
  }));

  const transitions = Object.keys(payload?.transitions ?? {});
  const mutes = Object.keys(payload?.mutes ?? {});

  const signalProcessors: SignalProcessorSummary[] = Object.entries(
    payload?.signalProcessors ?? {},
  ).map(([instrument, block]) => {
    const entries = block ? Object.entries(block) : [];
    const parameters = entries
      .filter(([key, value]) => key !== 'type' && Array.isArray(value))
      .map(([key]) => key);
    return {
      instrument,
      type: typeof block?.type === 'string' ? block.type : undefined,
      parameters,
    };
  });

  return {
    name: segment.name,
    kind: segment.type ?? inferSegmentKind(segment.name),
    bars: segment.lengthInBars ?? segment.bars.length,
    active: Boolean(payload),
    activeInstruments,
    chordProgression: summarizeChordProgression(segment),
    patterns,
    leadVocalLines,
    backingVocals,
    fills,
    transitions,
    mutes,
    signalProcessors,
  };
}

function extractSegmentLyricLines(
  payload: SegmentPayload | undefined,
  vocalInstrument: string,
): readonly LyricLineView[] {
  const override = payload?.overrides?.[vocalInstrument];
  if (!override?.bars) return [];
  const lines: LyricLineView[] = [];
  override.bars.forEach((bar, barIdx) => {
    const notes = bar.notes ?? {};
    for (const beat of Object.keys(notes)) {
      const events = notes[beat as keyof typeof notes] as NoteEvent[] | undefined;
      if (!events) continue;
      const words = events
        .map((ev) => (ev as { fullWord?: string }).fullWord)
        .filter((w): w is string => typeof w === 'string' && w.length > 0);
      const endOfPhrase = events.some(
        (ev) => (ev as { endOfPhrase?: boolean }).endOfPhrase === true,
      );
      if (words.length > 0 || endOfPhrase) {
        lines.push({ bar: barIdx, beat, words, endOfPhrase });
      }
    }
  });
  return lines;
}

function collectBackingVocalNames(
  payload: SegmentPayload | undefined,
  instruments: Readonly<Record<string, boolean>>,
): readonly string[] {
  const seen = new Set<string>();
  for (const name of Object.keys(instruments)) {
    if (name.startsWith(BACKING_VOCAL_PREFIX)) seen.add(name);
  }
  for (const name of Object.keys(payload?.overrides ?? {})) {
    if (name.startsWith(BACKING_VOCAL_PREFIX)) seen.add(name);
  }
  return [...seen].sort();
}

/**
 * Provenance of a card-displayed instrument — i.e. where the row that
 * the user is looking at actually came from. This is the data the UI
 * needs to stop pretending fixture rows are real catalog selections.
 *
 * Five sources are distinguished:
 *   - `catalog`: the brain's `selectInstruments` pass landed on a
 *     validated catalog entry. We carry the 16-hex id so the Sound
 *     Design / inspector views can deep-link into the catalog browser
 *     and surface the row's preset/library/family/lowLevel/style.
 *   - `adapterFixture`: the role is wired through the engine adapter's
 *     hard-coded fixture (vocaloid, drum-sub-instrument grafts) —
 *     useful audio path, but not a real selection. Labelled honestly.
 *   - `renderFixture`: the instrument exists only because a brain-
 *     roundtrip override pattern (`type: 'brainRoundtrip'`) lit it up.
 *   - `definitionOnly`: an `instrumentDefinitions` row exists but
 *     carries no 16-hex catalog id (legacy slice ids like
 *     `dev-drums-pop-01`). The card has a name but not a catalog row.
 *   - `unknown`: nothing in `instrumentDefinitions` for the role at
 *     all — the card was inferred purely from arrangement overrides.
 */
export type InstrumentProvenance =
  | 'catalog'
  | 'adapterFixture'
  | 'renderFixture'
  | 'definitionOnly'
  | 'unknown';

export interface InstrumentProvenanceInfo {
  readonly name: string;
  readonly provenance: InstrumentProvenance;
  readonly catalogId: string | undefined;
  readonly shortName: string | undefined;
  readonly library: string | undefined;
  readonly preset: string | undefined;
  readonly family: string | undefined;
  readonly lowLevel: string | undefined;
  readonly mainStyle: string | undefined;
  readonly addStyles: readonly string[];
  readonly matchedPath: string | undefined;
  /** Public instrument name from the catalog (data/instrument-aliases.json).
   *  Set once the catalog entry is known; the library / preset names stay
   *  internal and are not shown to users. */
  readonly publicName: string | undefined;
  /** Plain-language label for the provenance — what the card should
   *  display where it currently says "brainRoundtrip" or similar. */
  readonly badge: string;
}

/** Pattern type strings that signal a brain-roundtrip / adapter fixture
 *  payload rather than a real instrument selection. The list is small;
 *  if any pattern type is the only `type` on the override, the card is
 *  rendering an adapter / render fixture. */
const FIXTURE_PATTERN_TYPES = new Set(['brainRoundtrip']);

const VOCAL_FIXTURE_IDS = new Set(['vocaloid-default', 'vocaloid-classic']);

const CATALOG_ID_RE = /^[0-9a-f]{16}$/u;

function isCatalogId(id: string | number | undefined): id is string {
  return typeof id === 'string' && CATALOG_ID_RE.test(id);
}

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function pickStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

/** Slim projection of a validated catalog entry — just the fields the
 *  provenance helper needs. Matches what `apps/web/src/api/catalog.ts`
 *  `CatalogEntry` carries. Decoupled so the helper can be unit-tested
 *  without dragging the API client into the test surface. */
export interface CatalogEntryProjection {
  readonly id: string;
  readonly family?: string | null;
  readonly lowLevel?: string | null;
  readonly mainStyle?: string | null;
  readonly addStyles?: readonly string[] | null;
  readonly library?: string | null;
  readonly preset?: string | null;
  readonly matchedPath?: string | null;
  readonly publicName?: string;
}

/**
 * Split a definition's `shortName` ("library - preset") into the two
 * components when both halves are present. Returns `undefined` for a
 * side that the shortName doesn't carry. The orchestrator builds these
 * names in `instrumentDefinitionFromCatalog` (packages/arrangement); we
 * just reverse it so we can show preset / library without forcing an
 * extra catalog roundtrip for every card.
 */
export function splitShortName(
  shortName: string | undefined,
): { library?: string; preset?: string } {
  if (!shortName) return {};
  const idx = shortName.indexOf(' - ');
  if (idx <= 0) return { preset: shortName };
  const library = shortName.slice(0, idx).trim();
  const preset = shortName.slice(idx + 3).trim();
  return {
    ...(library ? { library } : {}),
    ...(preset ? { preset } : {}),
  };
}

/**
 * Resolve a single instrument card's provenance.
 *
 * The instrument definition is the primary source of truth; pattern
 * type strings from the arrangement let us flag pure adapter/render
 * fixtures (e.g. when the brain emitted no instrumentDefinition row
 * but a `brainRoundtrip` override lit the card up). An optional
 * `catalogEntry` arg lets a caller that has fetched
 * `/api/catalog/instruments/:id` fill in the columns the definition
 * itself doesn't carry (mainStyle / addStyles / matchedPath).
 */
export function resolveInstrumentProvenance(
  name: string,
  def: InstrumentDefinition | undefined,
  patternTypes: readonly string[] = [],
  catalogEntry?: CatalogEntryProjection | undefined,
): InstrumentProvenanceInfo {
  const details = (def?.details ?? {}) as Record<string, unknown>;
  const id = def?.id;
  const catalogId = isCatalogId(id) ? id : undefined;
  const shortName = pickString(def?.shortName);
  const shortSplit = splitShortName(shortName);

  // Priority: explicit catalog entry → values the brain stashed in
  // `details` → fields reverse-engineered from the definition itself.
  const library =
    pickString(catalogEntry?.library ?? undefined) ??
    pickString(details.library) ??
    shortSplit.library;
  const preset =
    pickString(catalogEntry?.preset ?? undefined) ??
    pickString(details.preset) ??
    shortSplit.preset;
  const family =
    pickString(catalogEntry?.family ?? undefined) ??
    pickString(details.family) ??
    pickString(def?.instrumentGroup);
  const lowLevel =
    pickString(catalogEntry?.lowLevel ?? undefined) ??
    pickString(details.lowLevel) ??
    pickString(def?.lowLevelType);
  const mainStyle =
    pickString(catalogEntry?.mainStyle ?? undefined) ??
    pickString(details.mainStyle);
  const addStyles =
    Array.isArray(catalogEntry?.addStyles) && catalogEntry.addStyles.length > 0
      ? pickStringArray(catalogEntry.addStyles)
      : pickStringArray(details.addStyles);
  const matchedPath =
    pickString(catalogEntry?.matchedPath ?? undefined) ??
    pickString(details.matchedPath);

  const fixtureFromPatterns =
    patternTypes.length > 0 &&
    patternTypes.every((t) => FIXTURE_PATTERN_TYPES.has(t));

  let provenance: InstrumentProvenance;
  let badge: string;
  if (catalogId) {
    provenance = 'catalog';
    badge = 'validated catalog';
  } else if (def && typeof id === 'string' && VOCAL_FIXTURE_IDS.has(id)) {
    provenance = 'adapterFixture';
    badge = 'vocaloid fixture';
  } else if (def) {
    provenance = 'definitionOnly';
    badge = 'legacy definition (no catalog id)';
  } else if (fixtureFromPatterns) {
    provenance = 'renderFixture';
    badge = 'render fixture (brain-roundtrip)';
  } else {
    provenance = 'unknown';
    badge = 'no instrument definition';
  }

  return {
    name,
    provenance,
    catalogId,
    shortName,
    library,
    preset,
    family,
    lowLevel,
    mainStyle,
    addStyles,
    matchedPath,
    publicName: catalogEntry?.publicName,
    badge,
  };
}

/** What the UI calls an instrument's sound: its public catalog name. A
 *  catalog sound whose entry is still loading shows "…"; a legacy or
 *  fixture definition (no catalog row, so no public name) shows its
 *  definition's shortName. */
export function soundLabel(info: InstrumentProvenanceInfo): string {
  if (info.publicName) return info.publicName;
  if (info.provenance === 'catalog') return '…';
  return info.shortName ?? '—';
}

/** Index a song's instrument definitions by display name so the views
 *  can resolve a card's provenance in O(1). */
export function indexInstrumentDefinitions(
  song: Song | undefined,
): Map<string, InstrumentDefinition> {
  const map = new Map<string, InstrumentDefinition>();
  if (!song) return map;
  for (const def of song.instrumentDefinitions ?? []) {
    map.set(def.name, def);
  }
  return map;
}

/** Collect the distinct `override.type` strings the brain emitted for a
 *  given instrument name across every segment of the song. */
export function patternTypesForInstrument(
  song: Song | undefined,
  instrumentName: string,
): readonly string[] {
  if (!song) return [];
  const types = new Set<string>();
  for (const seg of Object.values(song.arrangement)) {
    const override = seg?.overrides?.[instrumentName];
    if (override?.type) types.add(override.type);
  }
  return [...types];
}

export function generatorView(song: Song): GeneratorView | undefined {
  const g = song.generator;
  if (!g) return undefined;
  const params = (g.params ?? {}) as Record<string, unknown>;
  return {
    name: g.name ?? 'unknown',
    version: g.version ?? '—',
    seed: g.seed === undefined ? '—' : String(g.seed),
    genre: typeof params.genre === 'string' ? params.genre : song.genre ?? '—',
    key: typeof params.key === 'string' ? params.key : song.key,
    bpm: typeof params.bpm === 'number' ? params.bpm : song.bpm,
  };
}
