// docs/58 — Orchestral (popStrings + popBrass) pattern bank loader.
//
// Faithful port of the legacy
//   casperaki1/.../patterns/stringPatterns/LibraryStringPatternGeneratorClass.js
//   casperaki1/.../patterns/brassPatterns/LibraryBrassPatternGeneratorClass.js
//
// Both generators are the SAME shape: a per-genre style pick
// (config.json#defaultStyleMappings.{string,brass}Patterns →
// `Tools.selectRandomly`), then a uniform pick over the style's pattern
// bank, then per-hit `_addNoteRelative` emission. Each bank pattern is
//   { name, bpm, notes: { "<absHit>": [ { position, duration, velocity? }, ... ] } }
// and the legacy expansion (with the bpm `adjustmentFactor` commented out,
// i.e. fixed at 1) places each hit in bar `floor(absHit/4)` at beat
// `absHit % 4`, emitting a `noteRelative` event with
// `distanceFromMiddleC = note.position`, the note duration and velocity.
//
// The two roles differ only by their data directory + style map:
//   popStrings → data/patterns/strings/ (style 'stabs', StefanStabsPatterns.json)
//   popBrass   → data/patterns/brass/   (style 'schlager', StefanSchlagerPatterns.json)

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import type { Rng } from '@casperaki/music-theory';
import { GenreSchema } from '@casperaki/song-schema';

import { DataAssetError, type DataAssetMeta } from '../data/loader.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = resolve(HERE, '..', '..', 'data', 'patterns');

/** The two orchestral roles + their data subdirectory. */
export type OrchestralRole = 'popStrings' | 'popBrass';
const SUBDIR: Readonly<Record<OrchestralRole, string>> = {
  popStrings: 'strings',
  popBrass: 'brass',
};

// ---- schemas ----

const NoteSchema = z
  .object({
    position: z.number().int(),
    duration: z.number().nonnegative(),
    velocity: z.number().nonnegative().optional(),
  })
  .passthrough();

const PatternSchema = z
  .object({
    name: z.string().min(1),
    // Optional: legacy banded patterns carry no `bpm` field (only bpmLow/High);
    // only the `bpm === 'any'` patterns set it. Not used for logic — the band
    // filter reads bpmLow/bpmHigh.
    bpm: z.union([z.number().positive(), z.string()]).optional(),
    // bpm-band bounds (LibraryStringPatternGeneratorClass.js:29-30). Present
    // only when `bpm !== 'any'`; drive the bpm-band filter in
    // selectOrchestralPattern. Strings carry them; brass patterns omit them.
    bpmLow: z.union([z.number(), z.string()]).optional(),
    bpmHigh: z.union([z.number(), z.string()]).optional(),
    genre: z.string().optional(),
    notes: z.record(z.string(), z.array(NoteSchema)),
  })
  .passthrough();

const PatternBankSchema = z.array(PatternSchema).min(1);

const StyleEntrySchema = z.object({ file: z.string().min(1) });

const BankIndexSchema = z.object({
  $schemaVersion: z.literal(1),
  $description: z.string().optional(),
  $legacySource: z.record(z.string(), z.unknown()).optional(),
  styles: z.record(z.string().min(1), StyleEntrySchema),
  genreStyles: z.record(z.string().min(1), z.array(z.string().min(1)).min(1)),
});

// ---- public types ----

export interface OrchestralNote {
  readonly position: number;
  readonly duration: number;
  readonly velocity?: number;
}
export interface OrchestralPattern {
  readonly name: string;
  /** Authoring bpm; only set for `bpm === 'any'` legacy patterns. Metadata. */
  readonly bpm?: number;
  /** bpm-band bounds, parsed to numbers. Absent when `bpm === 'any'`. */
  readonly bpmLow?: number;
  readonly bpmHigh?: number;
  readonly notes: Readonly<Record<string, readonly OrchestralNote[]>>;
}
export interface OrchestralSelection {
  readonly styleName: string;
  readonly pattern: OrchestralPattern;
}

/** One expanded noteRelative event from an orchestral pattern. */
export interface ExpandedOrchestralEvent {
  readonly bar: number;
  readonly beat: number;
  readonly distanceFromMiddleC: number;
  readonly duration: number;
  readonly velocity?: number;
}
export interface ExpandedOrchestralPattern {
  readonly events: readonly ExpandedOrchestralEvent[];
  readonly barCount: number;
}

// ---- loader (cached per role) ----

interface ResolvedBank {
  readonly index: z.infer<typeof BankIndexSchema>;
  readonly styles: ReadonlyMap<string, readonly OrchestralPattern[]>;
}

const cache = new Map<OrchestralRole, ResolvedBank>();

function bankMeta(role: OrchestralRole): DataAssetMeta {
  return {
    filename: `${SUBDIR[role]}/bank-index.json`,
    legacyPath:
      role === 'popStrings'
        ? 'casperaki2-engine-js/api/v1.0/services/classes/patterns/stringPatterns/LibraryStringPatternGeneratorClass.js'
        : 'casperaki2-engine-js/api/v1.0/services/classes/patterns/brassPatterns/LibraryBrassPatternGeneratorClass.js',
    extractedAt: '2026-06-16',
  };
}

function loadBank(role: OrchestralRole): ResolvedBank {
  const hit = cache.get(role);
  if (hit) return hit;
  const dir = resolve(DATA_ROOT, SUBDIR[role]);
  const meta = bankMeta(role);
  let indexRaw: unknown;
  try {
    indexRaw = JSON.parse(readFileSync(resolve(dir, 'bank-index.json'), 'utf8'));
  } catch (err) {
    throw new DataAssetError(meta, `failed to load: ${(err as Error).message}`, err);
  }
  const indexParse = BankIndexSchema.safeParse(indexRaw);
  if (!indexParse.success) {
    throw new DataAssetError(
      meta,
      `manifest is malformed: ${indexParse.error.issues[0]?.message ?? 'unknown'}`,
    );
  }
  const index = indexParse.data;

  const styles = new Map<string, readonly OrchestralPattern[]>();
  for (const [styleName, { file }] of Object.entries(index.styles)) {
    const fileMeta: DataAssetMeta = { ...meta, filename: `${SUBDIR[role]}/${file}` };
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(resolve(dir, file), 'utf8'));
    } catch (err) {
      throw new DataAssetError(fileMeta, `failed to load: ${(err as Error).message}`, err);
    }
    const parsed = PatternBankSchema.safeParse(raw);
    if (!parsed.success) {
      throw new DataAssetError(
        fileMeta,
        `bank is malformed: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
      );
    }
    const toNum = (v: number | string | undefined): number | undefined => {
      if (v === undefined) return undefined;
      const n = typeof v === 'number' ? v : Number.parseInt(v, 10);
      return Number.isFinite(n) ? n : undefined;
    };
    const parseBpm = (v: number | string | undefined): number | undefined => {
      if (v === undefined) return undefined;
      const n = typeof v === 'number' ? v : Number.parseFloat(v);
      return Number.isFinite(n) ? n : undefined;
    };
    const patterns: OrchestralPattern[] = parsed.data.map((p) => ({
      name: p.name,
      ...(parseBpm(p.bpm) !== undefined ? { bpm: parseBpm(p.bpm) } : {}),
      ...(toNum(p.bpmLow) !== undefined ? { bpmLow: toNum(p.bpmLow) } : {}),
      ...(toNum(p.bpmHigh) !== undefined ? { bpmHigh: toNum(p.bpmHigh) } : {}),
      notes: Object.freeze(
        Object.fromEntries(
          Object.entries(p.notes).map(([hit, notes]) => [
            hit,
            Object.freeze(
              notes.map((n) => ({
                position: n.position,
                duration: n.duration,
                ...(typeof n.velocity === 'number' ? { velocity: n.velocity } : {}),
              })),
            ),
          ]),
        ),
      ),
    }));
    styles.set(styleName, Object.freeze(patterns));
  }

  for (const [genre, styleList] of Object.entries(index.genreStyles)) {
    for (const styleName of styleList) {
      if (!styles.has(styleName)) {
        throw new DataAssetError(
          meta,
          `genreStyles["${genre}"] references unknown style "${styleName}"`,
        );
      }
    }
  }

  const resolved: ResolvedBank = { index, styles };
  cache.set(role, resolved);
  return resolved;
}

/** Test-only — drop the in-memory caches so a re-load re-reads disk. */
export function _resetOrchestralBankCache(): void {
  cache.clear();
}

// ---- selection + expansion ----

/**
 * Pick one orchestral pattern for `(role, genre, bpm)` via the caller-owned
 * `Rng`. Legacy: `Tools.selectRandomly(config[<role>Patterns][genre])` for
 * the style, then a bpm-band filter (`e.bpm === 'any' || bpmLow <= bpm <=
 * bpmHigh`, LibraryStringPatternGeneratorClass.js:29-30), then
 * `Tools.selectRandomly(patterns)` for the pattern.
 *
 * `bpm` defaults to NaN, which disables the band filter (matching a bank
 * whose patterns are all `bpm === 'any'`, e.g. the brass `schlager` style).
 *
 * Throws `DataAssetError` on a non-canonical genre or a genre with no
 * mapped style for this role.
 */
export function selectOrchestralPattern(
  rng: Rng,
  role: OrchestralRole,
  genre: string,
  bpm = Number.NaN,
): OrchestralSelection {
  const parsed = GenreSchema.safeParse(genre);
  if (!parsed.success) {
    throw new DataAssetError(
      bankMeta(role),
      `unsupported genre "${genre}" — canonical genres are: ${GenreSchema.options.join(', ')}`,
    );
  }
  const bank = loadBank(role);
  const styleList = bank.index.genreStyles[parsed.data];
  if (!styleList || styleList.length === 0) {
    throw new DataAssetError(
      bankMeta(role),
      `no ${role} style is mapped to genre "${genre}" — extend ${SUBDIR[role]}/bank-index.json's genreStyles`,
    );
  }
  const styleName = rng.pick(styleList);
  const patterns = bank.styles.get(styleName)!;
  const pattern = rng.pick(bandFilter(patterns, bpm));
  return { styleName, pattern };
}

/**
 * Keep patterns whose bpm band contains `bpm` (legacy: `e.bpm === 'any' ||
 * bpmLow <= bpm <= bpmHigh`). A pattern with no band (`bpmLow`/`bpmHigh`
 * absent — i.e. legacy `bpm === 'any'`) always passes. When `bpm` is NaN the
 * filter is a no-op. If a (genre, bpm) combination filters everything out we
 * fall back to the full list rather than crash (legacy would throw on an
 * empty `selectRandomly`); every shipped genre has `any` patterns, so this
 * fallback is defensive only.
 */
function bandFilter(
  patterns: readonly OrchestralPattern[],
  bpm: number,
): readonly OrchestralPattern[] {
  if (!Number.isFinite(bpm)) return patterns;
  const inBand = patterns.filter(
    (p) =>
      p.bpmLow === undefined ||
      p.bpmHigh === undefined ||
      (p.bpmLow <= bpm && p.bpmHigh >= bpm),
  );
  return inBand.length > 0 ? inBand : patterns;
}

/** Whether a genre has any mapped style for the role (used by selection). */
export function orchestralHasGenreStyle(role: OrchestralRole, genre: string): boolean {
  const parsed = GenreSchema.safeParse(genre);
  if (!parsed.success) return false;
  const bank = loadBank(role);
  const styleList = bank.index.genreStyles[parsed.data];
  return styleList !== undefined && styleList.length > 0;
}

/**
 * Expand a picked pattern into noteRelative events (legacy adjustmentFactor = 1).
 *
 * `centerOctave` reproduces the strings-only octave normalization in
 * LibraryStringPatternGeneratorClass.js:70-99: shift every note by
 * `-12 * round(avgPosition / numNotes / 12)` so the pattern sits near middle
 * C regardless of the octave it was authored in. Brass passes `false` —
 * LibraryBrassPatternGeneratorClass.js emits `note.position` verbatim.
 */
export function expandOrchestralPattern(
  pattern: OrchestralPattern,
  centerOctave = false,
): ExpandedOrchestralPattern {
  let adjustment = 0;
  if (centerOctave) {
    let sum = 0;
    let count = 0;
    for (const notes of Object.values(pattern.notes)) {
      for (const n of notes) {
        sum += n.position;
        count++;
      }
    }
    if (count > 0) adjustment = -12 * Math.round(sum / count / 12);
  }
  const events: ExpandedOrchestralEvent[] = [];
  for (const [hitKey, notes] of Object.entries(pattern.notes)) {
    const absHit = Number.parseFloat(hitKey);
    if (!Number.isFinite(absHit)) continue;
    const bar = Math.floor(absHit / 4);
    const beat = absHit % 4;
    for (const n of notes) {
      events.push({
        bar,
        beat,
        distanceFromMiddleC: n.position + adjustment,
        duration: n.duration,
        ...(typeof n.velocity === 'number' ? { velocity: n.velocity } : {}),
      });
    }
  }
  const barCount = Math.max(
    1,
    events.reduce((max, e) => (e.bar > max ? e.bar : max), 0) + 1,
  );
  events.sort((a, b) => a.bar - b.bar || a.beat - b.beat);
  return { events: Object.freeze(events), barCount };
}

/** Read-only introspection for tests / docs / studio. */
export function describeOrchestralBank(role: OrchestralRole): {
  styles: readonly string[];
  genreStyles: Readonly<Record<string, readonly string[]>>;
  patternCount: Readonly<Record<string, number>>;
} {
  const bank = loadBank(role);
  const patternCount: Record<string, number> = {};
  for (const [name, patterns] of bank.styles) patternCount[name] = patterns.length;
  const genreStyles: Record<string, readonly string[]> = {};
  for (const [g, s] of Object.entries(bank.index.genreStyles)) genreStyles[g] = [...s];
  return { styles: [...bank.styles.keys()], genreStyles, patternCount };
}
