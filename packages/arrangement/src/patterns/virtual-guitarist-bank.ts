// docs/54y — Lane B virtualGuitarist pattern bank.
//
// Ports VirtualGuitaristPatternGeneratorClass.js:
//   1. Pick MAIN vs Stefan bank per genre (brightPop ≈60% main / 40%
//      Stefan; matches the legacy `Tools.selectRandomly([F,F,T,T,T])`
//      3-of-5 main slot).
//   2. MAIN bank pick: filter the style map by `genres.includes(genre)
//      && bpmMin <= bpm <= bpmMax`, random-pick one entry, resolve to
//      the named pattern.
//   3. Stefan bank pick: random pick from `Object.keys(stefanBank)`.
//   4. Post-process picked pattern:
//      a. Drop fx events not in [fx1, fx2, fx4, fx6]; track drop count.
//      b. Clamp strum durations at min 1.
//      c. Substitute each dropped fx with a random pick from
//         [fx1, fx2, fx4] (without replacement per beat).
//      d. Drop empty beats.
//
// Determinism: caller-owned Rng; same (rng-state, genre, bpm) →
// identical pick + identical substitution sequence.
//
// What this bank carries vs Lane A's `guitarPatterns.json`:
//   - Lane A bank: only `type:'strum'` events. Drives the per-string
//     long-notes-sampler emission.
//   - Lane B bank: `type:'virtualGuitarist'` (chord strums + fx) +
//     `type:'strum'` + `type:'fretNoise'` events. Lane B's generator
//     consumes the `virtualGuitarist` events ONLY (chord-strum +
//     fx1..fx7); the per-string `strum` events and fretNoise events
//     are owned by Lanes A and 54t respectively.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import type { Rng } from '@casperaki/music-theory';
import { GenreSchema, type Genre } from '@casperaki/song-schema';

import { DataAssetError, type DataAssetMeta } from '../data/loader.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(HERE, '..', '..', 'data', 'patterns', 'guitar');

// ---- schemas ----

// Pattern rows are opaque to the loader — Zod just validates the
// outer shape. Strum / virtualGuitarist event validation happens at
// consumption time in guitar.ts.
const BarSchema = z
  .object({
    notes: z.record(z.string(), z.array(z.unknown())).optional(),
  })
  .passthrough();
const PatternSchema = z.array(BarSchema).min(1);

const MainBankSchema = z.record(z.string().min(1), PatternSchema);
const StefanBankSchema = z.record(z.string().min(1), PatternSchema);

// Style-map entries carry bpm fields as STRINGS in the legacy JSON
// (`"bpmMin": "75"`). We coerce at parse time. The legacy JSON also
// carries a handful of malformed rows with `genres:[""]` and empty
// bpm strings (e.g. `Ample Guitar - Banjo_Default1`) — we accept
// them through the loose schema and filter them at selection time.
const StyleMapEntryLooseSchema = z.object({
  name: z.string().min(1),
  genres: z.array(z.string()),
  bpmMin: z.union([z.string(), z.number()]),
  bpmMax: z.union([z.string(), z.number()]),
});
const StyleMapSchema = z.array(StyleMapEntryLooseSchema).min(1);

interface NormalisedStyleMapEntry {
  readonly name: string;
  readonly genres: readonly string[];
  readonly bpmMin: number;
  readonly bpmMax: number;
}

function normaliseStyleMap(
  raw: readonly z.infer<typeof StyleMapEntryLooseSchema>[],
): NormalisedStyleMapEntry[] {
  const out: NormalisedStyleMapEntry[] = [];
  for (const e of raw) {
    const genres = e.genres.filter((g) => g.length > 0);
    if (genres.length === 0) continue;
    const bpmMin = Number(e.bpmMin);
    const bpmMax = Number(e.bpmMax);
    if (!Number.isFinite(bpmMin) || !Number.isFinite(bpmMax) || bpmMin <= 0 || bpmMax <= 0) {
      continue;
    }
    out.push({ name: e.name, genres, bpmMin, bpmMax });
  }
  return out;
}

// ---- public types ----

export interface VirtualGuitaristBankPattern {
  readonly name: string;
  readonly source: 'main' | 'stefan';
  readonly bars: readonly { readonly notes: Readonly<Record<string, readonly unknown[]>> }[];
}

export interface VirtualGuitaristBankSelection {
  /** The picked pattern's name ("Ample Guitar - 110-16-44-Funk-03"). */
  readonly patternName: string;
  readonly source: 'main' | 'stefan';
  readonly mainCandidateCount: number;
  readonly stefanCandidateCount: number;
  readonly pattern: VirtualGuitaristBankPattern;
}

// ---- per-genre split table ----
//
// Legacy generator picks MAIN vs STEFAN per-genre. brightPop and rock
// have explicit branches in the legacy switch; everything else falls
// through to the `default` branch which always picks MAIN.
//
// We mirror the legacy `Tools.selectRandomly(<flags>)` via
// `rng.pick(<flags>)` returning `true` ↔ MAIN, `false` ↔ STEFAN.
const GENRE_MAIN_STEFAN_FLAGS: Readonly<Record<string, readonly boolean[]>> = {
  brightPop: [false, false, true, true, true], // ≈60% MAIN
  rock: [false, false, true, true], // 50% MAIN
};

// ---- loader ----

const MAIN_META: DataAssetMeta = {
  filename: 'virtualGuitaristPatterns.json',
  legacyPath:
    'casperaki2-engine-js/api/v1.0/services/classes/patterns/guitarPatterns/virtualGuitaristPatterns.json',
  extractedAt: '2026-06-08',
};
const STEFAN_META: DataAssetMeta = {
  filename: 'virtualGuitaristStefanPatterns.json',
  legacyPath:
    'casperaki2-engine-js/api/v1.0/services/classes/patterns/guitarPatterns/virtualGuitaristStefanPatterns.json',
  extractedAt: '2026-06-08',
};
const STYLE_MAP_META: DataAssetMeta = {
  filename: 'virtualGuitaristStyleMap.json',
  legacyPath:
    'casperaki2-engine-js/api/v1.0/services/classes/patterns/guitarPatterns/virtualGuitaristStyleMap.json',
  extractedAt: '2026-06-08',
};

interface ResolvedVgBank {
  readonly main: ReadonlyMap<string, VirtualGuitaristBankPattern>;
  readonly stefan: ReadonlyMap<string, VirtualGuitaristBankPattern>;
  readonly styleMap: readonly NormalisedStyleMapEntry[];
  readonly stefanKeysSorted: readonly string[];
}

let cached: ResolvedVgBank | undefined;

function loadRaw<T>(meta: DataAssetMeta, schema: z.ZodSchema<T>): T {
  const path = resolve(DATA_DIR, meta.filename);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new DataAssetError(meta, `failed to load: ${(err as Error).message}`, err);
  }
  const parse = schema.safeParse(raw);
  if (!parse.success) {
    throw new DataAssetError(
      meta,
      `bank is malformed: ${parse.error.issues[0]?.message ?? 'unknown'}`,
    );
  }
  return parse.data;
}

function freezeBank(
  raw: Record<string, z.infer<typeof PatternSchema>>,
  source: 'main' | 'stefan',
): ReadonlyMap<string, VirtualGuitaristBankPattern> {
  const out = new Map<string, VirtualGuitaristBankPattern>();
  for (const [name, rawPattern] of Object.entries(raw)) {
    const bars = rawPattern.map((bar) => ({
      notes: Object.freeze(
        Object.fromEntries(
          Object.entries(bar.notes ?? {}).map(([beat, events]) => [
            beat,
            Object.freeze([...events]) as readonly unknown[],
          ]),
        ),
      ),
    }));
    out.set(name, { name, source, bars: Object.freeze(bars) });
  }
  return out;
}

function loadBank(): ResolvedVgBank {
  if (cached) return cached;
  const mainRaw = loadRaw(MAIN_META, MainBankSchema);
  const stefanRaw = loadRaw(STEFAN_META, StefanBankSchema);
  const styleMapRaw = loadRaw(STYLE_MAP_META, StyleMapSchema);
  const main = freezeBank(mainRaw, 'main');
  const stefan = freezeBank(stefanRaw, 'stefan');
  const stefanKeysSorted = Object.freeze([...stefan.keys()].sort());
  const styleMap = Object.freeze(normaliseStyleMap(styleMapRaw));
  cached = { main, stefan, styleMap, stefanKeysSorted };
  return cached;
}

/** Test-only — drop the in-memory cache so a re-load re-reads disk. */
export function _resetVirtualGuitaristBankCache(): void {
  cached = undefined;
}

// ---- selection ----

function pickSourceBank(rng: Rng, genre: string): 'main' | 'stefan' {
  const flags = GENRE_MAIN_STEFAN_FLAGS[genre];
  if (!flags) return 'main'; // legacy `default` branch
  return rng.pick(flags) ? 'main' : 'stefan';
}

function filterStyleMap(bank: ResolvedVgBank, genre: Genre, bpm: number): string[] {
  return bank.styleMap
    .filter((e) => e.genres.includes(genre) && e.bpmMin <= bpm && e.bpmMax >= bpm)
    .map((e) => e.name)
    .sort(); // stable iteration order across runs
}

/** Whether the legacy bank has patterns for this genre at this tempo (its main bank, filtered by the style map). */
export function virtualGuitaristBankHasPatterns(genre: string, bpm: number): boolean {
  const parsed = GenreSchema.safeParse(genre);
  if (!parsed.success) throw new DataAssetError(MAIN_META, `unsupported genre "${genre}"`);
  return filterStyleMap(loadBank(), parsed.data, bpm).length > 0;
}

/**
 * Deterministically pick one virtualGuitarist pattern.
 *
 * Throws `DataAssetError` on:
 *  - non-canonical genre,
 *  - empty MAIN candidate set after style-map filter,
 *  - empty Stefan bank when picked,
 *  - picked entry not resolving to a known pattern name.
 */
export function selectVirtualGuitaristPattern(
  rng: Rng,
  genre: string,
  bpm: number,
  /** A genre recipe's pattern families ("Funk", "R&B"): only the main bank's patterns of those names. */
  families?: readonly string[],
): VirtualGuitaristBankSelection {
  const genreParse = GenreSchema.safeParse(genre);
  if (!genreParse.success) {
    throw new DataAssetError(
      MAIN_META,
      `unsupported genre "${genre}" — canonical genres are: ${GenreSchema.options.join(', ')}`,
    );
  }
  if (!Number.isFinite(bpm) || bpm <= 0) {
    throw new DataAssetError(MAIN_META, `invalid bpm "${bpm}" — must be a positive finite number`);
  }
  const bank = loadBank();
  if (families) {
    const named = filterStyleMap(bank, genreParse.data, bpm).filter((n) => families.some((f) => n.includes(`-${f}-`)));
    if (named.length === 0) {
      throw new DataAssetError(STYLE_MAP_META, `no virtualGuitarist pattern of the families ${families.join(', ')} for genre="${genre}" bpm=${bpm}`);
    }
    const patternName = rng.pick(named);
    const pattern = bank.main.get(patternName);
    if (!pattern) throw new DataAssetError(MAIN_META, `the style map names "${patternName}", which the main bank does not have`);
    return { patternName, source: 'main', mainCandidateCount: named.length, stefanCandidateCount: 0, pattern };
  }
  const source = pickSourceBank(rng, genreParse.data);
  const mainCandidates = filterStyleMap(bank, genreParse.data, bpm);
  const stefanCandidates = bank.stefanKeysSorted;

  let patternName: string;
  let resolvedSource: 'main' | 'stefan';
  if (source === 'main') {
    if (mainCandidates.length === 0) {
      throw new DataAssetError(
        STYLE_MAP_META,
        `no virtualGuitarist style-map entries match genre="${genre}" bpm=${bpm}`,
      );
    }
    patternName = rng.pick(mainCandidates);
    resolvedSource = 'main';
  } else {
    if (stefanCandidates.length === 0) {
      throw new DataAssetError(STEFAN_META, `Stefan bank is empty`);
    }
    patternName = rng.pick(stefanCandidates);
    resolvedSource = 'stefan';
  }

  const pattern =
    resolvedSource === 'main' ? bank.main.get(patternName) : bank.stefan.get(patternName);
  if (!pattern) {
    throw new DataAssetError(
      resolvedSource === 'main' ? MAIN_META : STEFAN_META,
      `picked entry "${patternName}" not found in ${resolvedSource} bank`,
    );
  }
  return {
    patternName,
    source: resolvedSource,
    mainCandidateCount: mainCandidates.length,
    stefanCandidateCount: stefanCandidates.length,
    pattern,
  };
}

// ---- pattern post-processing (legacy port) ----

const ALLOWED_FX = new Set(['fx1', 'fx2', 'fx4', 'fx6']);
const FX_SUBSTITUTION_POOL: readonly string[] = ['fx1', 'fx2', 'fx4'];

interface RawNoteEvent {
  type?: unknown;
  event?: unknown;
  chord?: unknown;
  chordPosition?: unknown;
  duration?: unknown;
  durations?: unknown;
  strings?: unknown;
  offset?: unknown;
  velocities?: unknown;
  [key: string]: unknown;
}

/**
 * Apply the legacy generator's bar post-processing to a picked pattern.
 * Pure: input is the read-only bank pattern; output is a deep-cloned
 * post-processed version.
 *
 * The fx-substitution step is deterministic given the supplied rng —
 * each beat's substitution pool is shuffled by sequential
 * `rng.pick(pool)` calls.
 */
export function postProcessVirtualGuitaristPattern(
  rng: Rng,
  pattern: VirtualGuitaristBankPattern,
): VirtualGuitaristBankPattern {
  const newBars = pattern.bars.map((bar) => {
    const newNotes: Record<string, RawNoteEvent[]> = {};
    const beatKeys = Object.keys(bar.notes).sort(
      (a, b) => Number.parseFloat(a) - Number.parseFloat(b),
    );
    for (const beatKey of beatKeys) {
      const events = bar.notes[beatKey] as readonly RawNoteEvent[];
      const out: RawNoteEvent[] = [];
      let substitutionPool: string[] = [...FX_SUBSTITUTION_POOL];
      let numberOfRequiredSubstitutionFX = 0;
      for (const note of events) {
        // 1. fx filter — drop fx events not in the allowed set.
        if (
          note?.type === 'virtualGuitarist' &&
          typeof note.event === 'string' &&
          note.event.substring(0, 2) === 'fx'
        ) {
          if (!ALLOWED_FX.has(note.event)) {
            numberOfRequiredSubstitutionFX++;
            continue;
          }
          // Allowed fx — also remove from the substitution pool so the
          // legacy "without replacement" behaviour for substitutions
          // doesn't double up. Matches
          // VirtualGuitaristPatternGeneratorClass.js:125.
          substitutionPool = substitutionPool.filter((p) => p !== note.event);
        }
        // 2. Strum durations clamped at min 1.
        if (note?.type === 'strum' && Array.isArray(note.durations)) {
          out.push({
            ...note,
            durations: (note.durations as unknown[]).map((e) =>
              Math.max(typeof e === 'number' ? e : Number(e), 1),
            ),
          });
        } else {
          out.push({ ...note });
        }
      }
      // 3. fx substitution — append random picks from the pool.
      for (let i = 0; i < numberOfRequiredSubstitutionFX; i++) {
        if (substitutionPool.length === 0) break;
        const chosen = rng.pick(substitutionPool);
        out.push({ type: 'virtualGuitarist', event: chosen });
        substitutionPool = substitutionPool.filter((p) => p !== chosen);
      }
      // 4. Drop empty beats.
      if (out.length > 0) newNotes[beatKey] = out;
    }
    return { notes: Object.freeze(newNotes) as Readonly<Record<string, RawNoteEvent[]>> };
  });
  return {
    name: pattern.name,
    source: pattern.source,
    bars: Object.freeze(newBars),
  };
}

/** Read-only introspection for tests / docs / studio. */
export function describeVirtualGuitaristBank(): {
  mainTotal: number;
  stefanTotal: number;
  styleMapTotal: number;
  brightPopBpmRanges: ReadonlyArray<{ name: string; bpmMin: number; bpmMax: number }>;
} {
  const bank = loadBank();
  return {
    mainTotal: bank.main.size,
    stefanTotal: bank.stefan.size,
    styleMapTotal: bank.styleMap.length,
    brightPopBpmRanges: bank.styleMap
      .filter((e) => e.genres.includes('brightPop'))
      .map((e) => ({ name: e.name, bpmMin: e.bpmMin, bpmMax: e.bpmMax })),
  };
}
