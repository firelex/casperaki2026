// Transition sounds: which library recordings a transition type can play, the
// deterministic pick the generator stores in each transition entry
// (`soundId`), and how lowering turns a stored soundId into the file to play.
//
// Shared by the generator (arrangement), lowering (engine-adapter) and the
// brain (sound lists, previews), so all three agree on eligibility.
//
// What a soundId means:
//   - plain one-shots (crash, impacts, downlifter, sweep, reverse, uplifter,
//     8-bit fx): the catalog row itself.
//   - fxTonalReverse: a *pack* (one preset recorded in all 12 keys). The
//     soundId names the pack through any of its rows; lowering plays the
//     pack's recording in the key of the section's final chord root (legacy
//     TransitionsClass.js:366 selected by `sampleDetails.note`).
//   - percussionBreaksFills / percussionBreaksBuildups: a *pack* (one preset
//     rendered at every bpm; the bpm is part of the preset name). Lowering
//     plays the pack's row at the song tempo, else the nearest bpm of that
//     pack (legacy TransitionsClass.js:458 selected `sampleDetails.bpm =
//     tempo`; the library is pre-rendered, never time-stretched).
//   - edmSnareDrumRoll (a two-snare pattern) and fxNoiseRise (synthesized)
//     have no soundId: they are not swappable.

import type { ValidatedCatalog, ValidatedCatalogEntry } from '../catalog/validated-catalog.js';

export interface TransitionSoundLane {
  readonly family: string;
  readonly lowLevel: string;
  /** Key-matched pack (fxTonalReverse). */
  readonly tonal?: true;
  /** Bpm-matched pack (percussionBreaks*). */
  readonly bpmMatched?: true;
}

/** Transition tag → the library rows it plays. */
export const TRANSITION_SOUND_LANES: Readonly<Record<string, TransitionSoundLane>> = {
  cymbalsCrashHit: { family: 'cymbals', lowLevel: 'cymbalsCrashHit' },
  fxDownlifter: { family: 'fx', lowLevel: 'fxDownlifter' },
  fxHighImpact: { family: 'fx', lowLevel: 'fxHighImpact' },
  fxLowImpact: { family: 'fx', lowLevel: 'fxLowImpact' },
  fxTransition: { family: 'fx', lowLevel: 'fxTransition' },
  // docs/58e — the `fxOther` tag points at the renamed 8-bit arcade rows.
  fxOther: { family: 'fx', lowLevel: 'fx8bitArcade' },
  fxReverse: { family: 'fx', lowLevel: 'fxReverse' },
  fxTonalReverse: { family: 'fx', lowLevel: 'fxTonalReverse', tonal: true },
  fxUplifter: { family: 'fx', lowLevel: 'fxUplifter' },
  percussionBreaksBuildups: { family: 'percussionBreaks', lowLevel: 'percussionBreaksBuildups', bpmMatched: true },
  percussionBreaksFills: { family: 'percussionBreaks', lowLevel: 'percussionBreaksFills', bpmMatched: true },
  // Preview-only one-shot lanes (the Sounds page plays every library sound
  // through the engine): the generator never emits these tags and users
  // cannot add them (setTransition only takes TRANSITION_TYPES). The
  // synthesized noise rise keeps the `fxNoiseRise` tag; its library samples
  // play under `fxNoiseRiseSample`.
  fxAtmosphere: { family: 'fx', lowLevel: 'fxAtmosphere' },
  fxFretNoise: { family: 'fx', lowLevel: 'fxFretNoise' },
  fxNoiseRiseSample: { family: 'fx', lowLevel: 'fxNoiseRise' },
  percussionMiscAcousticHigh: { family: 'percussionMisc', lowLevel: 'percussionMiscAcousticHigh' },
  percussionMiscAcousticLow: { family: 'percussionMisc', lowLevel: 'percussionMiscAcousticLow' },
  percussionMiscElectronicHigh: { family: 'percussionMisc', lowLevel: 'percussionMiscElectronicHigh' },
  percussionMiscElectronicLow: { family: 'percussionMisc', lowLevel: 'percussionMiscElectronicLow' },
};

/** Transition tags that only exist to preview a sound (never generated, never user-added). */
export const PREVIEW_ONLY_TRANSITION_TAGS: ReadonlySet<string> = new Set([
  'fxAtmosphere',
  'fxFretNoise',
  'fxNoiseRiseSample',
  'percussionMiscAcousticHigh',
  'percussionMiscAcousticLow',
  'percussionMiscElectronicHigh',
  'percussionMiscElectronicLow',
]);

/** Whether a transition tag plays a library sound the user can choose. */
export function isSwappableTransition(tag: string): boolean {
  return tag in TRANSITION_SOUND_LANES && !PREVIEW_ONLY_TRANSITION_TAGS.has(tag);
}

// Enharmonic-aware pitch class (0..11), so a chord rooted on Bb matches a row keyed A#.
const PITCH_CLASS: Readonly<Record<string, number>> = {
  C: 0, 'B#': 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, Fb: 4, F: 5, 'E#': 5,
  'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11, Cb: 11,
};

export function pitchClassOf(name: string | null | undefined): number | null {
  if (!name) return null;
  const m = /^([A-G][#b]?)/u.exec(name.trim());
  if (!m) return null;
  return PITCH_CLASS[m[1]!] ?? null;
}

/** Root of a section's final chord (last chord of the last bar with chords):
 *  legacy `Tools.getFinalChordForSegment` (casperaki1 tools.js:1633). */
export function finalChordRootForSegment(bars: ReadonlyArray<{ chords?: readonly string[] }> | undefined): string | null {
  if (!bars || bars.length === 0) return null;
  for (let b = bars.length - 1; b >= 0; b--) {
    const chords = bars[b]?.chords;
    if (!chords || chords.length === 0) continue;
    const m = /[A-G][#b]?/u.exec(chords[chords.length - 1] ?? '');
    if (m) return m[0];
  }
  return null;
}

/** The pack a row belongs to (rows of one preset in every key / at every bpm). */
export function transitionPackKey(tag: string, e: ValidatedCatalogEntry): string {
  const lane = laneOf(tag);
  const preset = lane.bpmMatched ? (e.preset ?? '').replace(/_?\d{2,3}bpm/iu, '') : (e.preset ?? '');
  return `${e.lowLevel}|${e.library ?? ''}|${preset}`;
}

function laneOf(tag: string): TransitionSoundLane {
  const lane = TRANSITION_SOUND_LANES[tag];
  if (!lane) throw new Error(`transition "${tag}" plays no library sound`);
  return lane;
}

function laneRows(catalog: ValidatedCatalog, tag: string): ValidatedCatalogEntry[] {
  const lane = laneOf(tag);
  return catalog.entries.filter((e) => e.family === lane.family && e.lowLevel === lane.lowLevel);
}

function nearestBpm<T extends { bpm?: number | null }>(rows: readonly T[], tempo: number): T[] {
  const withBpm = rows.filter((e): e is T & { bpm: number } => typeof e.bpm === 'number');
  if (withBpm.length === 0) return [...rows];
  const exact = withBpm.filter((e) => e.bpm === tempo);
  if (exact.length > 0) return exact;
  let nearest = withBpm[0]!.bpm;
  for (const e of withBpm) {
    const d = Math.abs(e.bpm - tempo);
    const best = Math.abs(nearest - tempo);
    if (d < best || (d === best && e.bpm < nearest)) nearest = e.bpm;
  }
  return withBpm.filter((e) => e.bpm === nearest);
}

export interface TransitionSoundContext {
  readonly genre: string;
  /** Song tempo (bpm-matched packs). */
  readonly tempo: number;
  /** The section's final chord root (tonal packs). */
  readonly finalChordRoot: string | null;
}

export interface PickedTransitionSound {
  readonly entry: ValidatedCatalogEntry;
  /** Whether the pick came from rows of the song's genre, or all rows of the lane. */
  readonly source: 'genre' | 'fallback';
}

/**
 * The deterministic pick (previously done at lowering, docs/54n): the lane's
 * rows, key-matched (tonal) or bpm-matched, the genre's rows first (else all),
 * sorted by id, index = fnv1a(seed:segment:tag). Null when no row fits (a
 * tonal lane without that key): the legacy skipped the transition then
 * (TransitionsClass.js:373, 464 `continue`).
 */
export function pickTransitionSound(
  catalog: ValidatedCatalog,
  tag: string,
  ctx: TransitionSoundContext,
  seed: string,
  segmentName: string,
): PickedTransitionSound | null {
  const lane = laneOf(tag);
  let all = laneRows(catalog, tag);
  if (all.length === 0) return null;
  if (lane.tonal) {
    const want = pitchClassOf(ctx.finalChordRoot);
    if (want === null) return null;
    all = all.filter((e) => pitchClassOf(e.key) === want);
    if (all.length === 0) return null;
  }
  // (Callers that do not know the tempo pass NaN: no bpm narrowing, as the old lowering pick did without a tempo.)
  if (lane.bpmMatched && Number.isFinite(ctx.tempo)) all = nearestBpm(all, ctx.tempo);
  const inGenre = all.filter((e) => e.mainStyle === ctx.genre || ((e.addStyles ?? []) as readonly string[]).includes(ctx.genre));
  const pool = inGenre.length > 0 ? inGenre : all;
  const sorted = pool.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const idx = fnv1a(`${seed}:${segmentName}:${tag}`) % sorted.length;
  return { entry: sorted[idx]!, source: inGenre.length > 0 ? 'genre' : 'fallback' };
}

/**
 * The file a stored soundId plays in a section: the row itself, or the
 * pack's row for the section's key (tonal) / the song tempo (bpm-matched).
 * Throws when the soundId is not a sound of this transition, or the pack
 * has no recording in that key.
 */
export function resolveTransitionSound(
  catalog: ValidatedCatalog,
  tag: string,
  soundId: string,
  ctx: { tempo: number; finalChordRoot: string | null },
): ValidatedCatalogEntry {
  const lane = laneOf(tag);
  const row = catalog.byId.get(soundId);
  if (!row) throw new Error(`transition ${tag}: sound ${soundId} is not in the validated library`);
  if (row.family !== lane.family || row.lowLevel !== lane.lowLevel) {
    throw new Error(`transition ${tag}: sound ${soundId} is a ${row.lowLevel}, not a ${lane.lowLevel}`);
  }
  if (!lane.tonal && !lane.bpmMatched) return row;
  const pack = transitionPackKey(tag, row);
  const rows = laneRows(catalog, tag).filter((e) => transitionPackKey(tag, e) === pack);
  if (lane.tonal) {
    const want = pitchClassOf(ctx.finalChordRoot);
    if (want === null) throw new Error(`transition ${tag}: the section has no final chord to pick the key of sound ${soundId}`);
    const keyed = rows.filter((e) => pitchClassOf(e.key) === want);
    if (keyed.length === 0) throw new Error(`transition ${tag}: sound ${soundId} has no recording in ${ctx.finalChordRoot}`);
    return keyed.sort((a, b) => (a.id < b.id ? -1 : 1))[0]!;
  }
  return nearestBpm(rows, ctx.tempo).sort((a, b) => (a.id < b.id ? -1 : 1))[0]!;
}

/**
 * The sounds a user can choose for a transition: one per row, or one per
 * pack for tonal / bpm-matched lanes (the pack's row in C, or nearest
 * 120 bpm, stands for it — that row is also what previews play).
 */
export function transitionSoundChoices(catalog: ValidatedCatalog, tag: string): ValidatedCatalogEntry[] {
  const lane = laneOf(tag);
  const rows = laneRows(catalog, tag);
  if (!lane.tonal && !lane.bpmMatched) return rows;
  const packs = new Map<string, ValidatedCatalogEntry[]>();
  for (const e of rows) {
    const k = transitionPackKey(tag, e);
    const list = packs.get(k) ?? [];
    list.push(e);
    packs.set(k, list);
  }
  const out: ValidatedCatalogEntry[] = [];
  for (const list of packs.values()) {
    const sorted = list.slice().sort((a, b) => (a.id < b.id ? -1 : 1));
    const rep = lane.tonal ? (sorted.find((e) => pitchClassOf(e.key) === 0) ?? sorted[0]!) : nearestBpm(sorted, 120)[0]!;
    out.push(rep);
  }
  return out;
}

/** Whether `soundId` can be chosen for `tag` (any row of the lane; packs by any of their rows). */
export function isTransitionSoundFor(catalog: ValidatedCatalog, tag: string, soundId: string): boolean {
  const lane = TRANSITION_SOUND_LANES[tag];
  const row = catalog.byId.get(soundId);
  return Boolean(lane && row && row.family === lane.family && row.lowLevel === lane.lowLevel);
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
