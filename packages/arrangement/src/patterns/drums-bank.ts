// Legacy-derived drum pattern bank — loader + selector.
//
// Bank shape mirrors the legacy `drLukePatterns.json` / `rockPatterns.json`
// fixtures verbatim: each blueprint is `{ [lane: string]: number[] }` where
// each number is a beat position (0-indexed within the blueprint's bar(s);
// the legacy generator multiplied by 8 to get a 32nd-note slot index, so a
// value of 1.5 means "the &-of-beat 2" → BarBeat key "1.5").
//
// Per-blueprint bar length is computed from `max(position) / 4` ceiled —
// the same `ceil(lastHit/32)*32` rule the legacy
// `PopRockDrumPatternGeneratorClass.createDrumPattern` used.
//
// Legacy source files:
//   - data/patterns/drums/drLuke.json   ← drLukePatterns.json
//   - data/patterns/drums/rock.json     ← rockPatterns.json
//   - data/patterns/drums/bank-index.json (manifest authored here)
//
// Per-genre style mapping is intentionally permissive today (every canonical
// brain genre resolves to *some* imported style — see `bank-index.json`'s
// `genreStyles` block + docs/53u). Per-genre dedicated banks (latin / urban
// / EDM / schlager / hipHop / organicVibes) are deferred to the import-
// inventory campaign in docs/53k.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { GenreSchema, type Genre } from '@casperaki/song-schema';

import type { Rng } from '@casperaki/music-theory';

import { DataAssetError, type DataAssetMeta } from '../data/loader.js';
import {
  ALGO_STYLE_NAMES,
  generateAlgoBlueprint,
  isAlgoStyleName,
  type AlgoStyleName,
  type LibraryPick,
} from './drums-algo.js';
import { AUTHORED_DRUM_ALGOS } from './drums-authored.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(HERE, '..', '..', 'data', 'patterns', 'drums');

// ---- schemas (parsed once on load) ----

// Positions are 0-indexed beats. The legacy bank uses `-1` as a sentinel
// inside the rockPatterns.json `bassDrum2` lane to mean "don't auto-double
// this lane into bar 2" (see PopRockDrumPatternGeneratorClass.createDrumPattern
// for the legacy `if (item !== -1)` filter). The generator skips any position
// `< 0`, so this schema accepts the sentinel verbatim rather than forking
// the legacy JSON to drop it.
const PositionSchema = z.number();

const BlueprintSchema = z.record(z.string().min(1), z.array(PositionSchema).min(1));

const StyleBankSchema = z.array(BlueprintSchema).min(1);

const LaneSchema = z.object({
  midi: z.number().int().min(0).max(127),
});

// A style is EITHER a library bank (a JSON file of fixed blueprints) OR an
// algorithmic generator (docs/58 — the legacy *GeneratorClass.js port in
// drums-algo.ts). `algo` names the generator; see `ALGO_STYLE_NAMES`.
const StyleEntrySchema = z.union([
  z.object({ file: z.string().min(1) }),
  z.object({ algo: z.string().min(1) }),
  // A Casperaki-written generator (drums-authored.ts), wired in when its
  // proposal is approved in the pattern lab.
  z.object({ authoredAlgo: z.string().min(1) }),
]);

const BankIndexSchema = z.object({
  $schemaVersion: z.literal(1),
  $description: z.string().optional(),
  $legacySource: z.record(z.string(), z.string()).optional(),
  lanes: z.record(z.string().min(1), LaneSchema),
  styles: z.record(z.string().min(1), StyleEntrySchema),
  genreStyles: z.record(z.string().min(1), z.array(z.string().min(1)).min(1)),
});

// ---- public types ----

/** One legacy blueprint: lane → list of beat positions. */
export type DrumBlueprint = Readonly<Record<string, readonly number[]>>;

/** Resolved bank for one style: blueprints + the lane → MIDI lookup. */
export interface DrumStyleBank {
  readonly styleName: string;
  /** `'library'` = fixed JSON blueprints; `'algo'` = generator (drums-algo). */
  readonly kind: 'library' | 'algo' | 'authoredAlgo';
  /** Generator name when `kind === 'algo'` (see `ALGO_STYLE_NAMES`). */
  readonly algoName?: AlgoStyleName;
  /** Generator name when `kind === 'authoredAlgo'` (see `AUTHORED_DRUM_ALGOS`). */
  readonly authoredAlgoName?: string;
  readonly blueprints: readonly DrumBlueprint[];
  readonly laneMidi: Readonly<Record<string, number>>;
}

export interface DrumBankSelection {
  readonly styleName: string;
  readonly blueprintIndex: number;
  readonly blueprint: DrumBlueprint;
  readonly blueprintBars: number;
  readonly laneMidi: Readonly<Record<string, number>>;
}

// ---- loaders (cached after first read) ----

const BANK_INDEX_META: DataAssetMeta = {
  filename: 'bank-index.json',
  legacyPath:
    'casperaki2-engine-js/api/v1.0/services/classes/patterns/drumPatterns/PopRockDrumPatternGeneratorClass.js (style→method switch)',
  extractedAt: '2026-06-06',
};

interface ResolvedBank {
  readonly index: z.infer<typeof BankIndexSchema>;
  readonly styles: ReadonlyMap<string, DrumStyleBank>;
}

let cached: ResolvedBank | undefined;

function loadBank(): ResolvedBank {
  if (cached) return cached;
  const indexPath = resolve(DATA_DIR, BANK_INDEX_META.filename);
  let indexRaw: unknown;
  try {
    indexRaw = JSON.parse(readFileSync(indexPath, 'utf8'));
  } catch (err) {
    throw new DataAssetError(
      BANK_INDEX_META,
      `failed to load: ${(err as Error).message}`,
      err,
    );
  }
  const indexParse = BankIndexSchema.safeParse(indexRaw);
  if (!indexParse.success) {
    throw new DataAssetError(
      BANK_INDEX_META,
      `manifest is malformed: ${indexParse.error.issues[0]?.message ?? 'unknown'}`,
    );
  }
  const index = indexParse.data;

  // Shared lane → MIDI lookup (identical for every style).
  const laneMidiShared: Record<string, number> = {};
  for (const [name, { midi }] of Object.entries(index.lanes)) laneMidiShared[name] = midi;
  const laneMidiFrozen = Object.freeze(laneMidiShared);

  const styles = new Map<string, DrumStyleBank>();
  for (const [styleName, entry] of Object.entries(index.styles)) {
    // Algorithmic style — no JSON bank file; blueprints are generated on
    // demand by drums-algo.ts (docs/58 legacy *GeneratorClass.js port).
    if ('algo' in entry) {
      if (!isAlgoStyleName(entry.algo)) {
        throw new DataAssetError(
          BANK_INDEX_META,
          `style "${styleName}" references unknown algo generator "${entry.algo}" — known: ${ALGO_STYLE_NAMES.join(', ')}`,
        );
      }
      styles.set(styleName, {
        styleName,
        kind: 'algo',
        algoName: entry.algo,
        blueprints: [],
        laneMidi: laneMidiFrozen,
      });
      continue;
    }
    if ('authoredAlgo' in entry) {
      if (!(entry.authoredAlgo in AUTHORED_DRUM_ALGOS)) {
        throw new DataAssetError(
          BANK_INDEX_META,
          `style "${styleName}" references unknown authored generator "${entry.authoredAlgo}" — known: ${Object.keys(AUTHORED_DRUM_ALGOS).join(', ')}`,
        );
      }
      styles.set(styleName, {
        styleName,
        kind: 'authoredAlgo',
        authoredAlgoName: entry.authoredAlgo,
        blueprints: [],
        laneMidi: laneMidiFrozen,
      });
      continue;
    }
    const { file } = entry;
    const styleMeta: DataAssetMeta = {
      filename: file,
      legacyPath: `casperaki2-engine-js/api/v1.0/services/classes/patterns/drumPatterns/data/${file}`,
      extractedAt: '2026-06-06',
    };
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(resolve(DATA_DIR, file), 'utf8'));
    } catch (err) {
      throw new DataAssetError(
        styleMeta,
        `failed to load: ${(err as Error).message}`,
        err,
      );
    }
    const parsed = StyleBankSchema.safeParse(raw);
    if (!parsed.success) {
      throw new DataAssetError(
        styleMeta,
        `bank is malformed: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
      );
    }
    for (let i = 0; i < parsed.data.length; i++) {
      for (const lane of Object.keys(parsed.data[i]!)) {
        if (index.lanes[lane] === undefined) {
          throw new DataAssetError(
            styleMeta,
            `blueprint ${i} uses lane "${lane}" not declared in bank-index.json's lanes`,
          );
        }
      }
    }
    styles.set(styleName, {
      styleName,
      kind: 'library',
      blueprints: parsed.data.map((bp) => Object.freeze({ ...bp }) as DrumBlueprint),
      laneMidi: laneMidiFrozen,
    });
  }

  for (const [genre, styleList] of Object.entries(index.genreStyles)) {
    for (const styleName of styleList) {
      if (!styles.has(styleName)) {
        throw new DataAssetError(
          BANK_INDEX_META,
          `genreStyles["${genre}"] references unknown style "${styleName}"`,
        );
      }
    }
  }

  cached = { index, styles };
  return cached;
}

/** Test-only — drops the in-memory cache so a re-load re-reads disk. */
export function _resetDrumBankCache(): void {
  cached = undefined;
}

// ---- selection ----

const BEATS_PER_BAR_LEGACY = 4;

function blueprintBars(blueprint: DrumBlueprint): number {
  let lastBeat = 0;
  for (const positions of Object.values(blueprint)) {
    for (const p of positions) {
      if (p < 0) continue;
      if (p > lastBeat) lastBeat = p;
    }
  }
  const lastSlot = lastBeat * 8;
  const slots = Math.max(32, Math.ceil(lastSlot / 32) * 32);
  return Math.max(1, slots / 32);
}

/** One of `styles` (no draw for one), each a style of the bank. */
function pickStyle(styles: readonly string[], rng: Rng): string {
  if (styles.length === 0) throw new Error('selectDrumBlueprint: an empty list of drum styles');
  const bank = loadBank();
  const unknown = styles.filter((s) => !bank.styles.has(s));
  if (unknown.length) throw new DataAssetError(BANK_INDEX_META, `no drum style ${unknown.map((s) => `"${s}"`).join(', ')} in the bank`);
  return styles.length === 1 ? styles[0]! : rng.pick(styles);
}

function styleForGenre(genre: Genre, rng: Rng): string {
  const bank = loadBank();
  const list = bank.index.genreStyles[genre];
  if (!list || list.length === 0) {
    throw new DataAssetError(
      BANK_INDEX_META,
      `no drum style is mapped to genre "${genre}" — extend bank-index.json's genreStyles, or import a dedicated bank file under data/patterns/drums/`,
    );
  }
  // One style: no draw, so songs from before a genre gained a second style
  // keep their exact drums. Several (legacy + Casperaki-written): pick one.
  return list.length === 1 ? list[0]! : rng.pick(list);
}

/**
 * Deterministically pick one legacy drum blueprint for `genre`, using a
 * caller-owned `Rng` (the brain forks `ctx.rng.fork('patterns/drums')`).
 *
 * Throws `DataAssetError` if the genre has no style mapping or the chosen
 * style's bank is empty. Validates `genre` against `GenreSchema` so any
 * non-canonical input fails at the boundary, never as a silent fallback.
 */
export function selectDrumBlueprint(rng: Rng, genre: string, styles?: readonly string[]): DrumBankSelection {
  const parsed = GenreSchema.safeParse(genre);
  if (!parsed.success) {
    throw new DataAssetError(
      BANK_INDEX_META,
      `unsupported genre "${genre}" — canonical genres are: ${GenreSchema.options.join(', ')}`,
    );
  }
  const bank = loadBank();
  // A genre recipe may name the styles of a section type (Casperaki Pop's verses: the Urban styles).
  const styleName = styles ? pickStyle(styles, rng) : styleForGenre(parsed.data, rng);
  const style = bank.styles.get(styleName);
  if (!style) throw new DataAssetError(BANK_INDEX_META, `no drum style "${styleName}" in the bank`);

  if (style.kind === 'authoredAlgo') {
    const blueprint = AUTHORED_DRUM_ALGOS[style.authoredAlgoName!]!(rng, makeLibraryPick(bank, rng));
    return { styleName, blueprintIndex: -1, blueprint, blueprintBars: blueprintBars(blueprint), laneMidi: style.laneMidi };
  }

  if (style.kind === 'algo') {
    // Algorithmic generators consume `rng` to roll busyness + the legacy
    // per-lane choices, and may delegate to a LIBRARY style for popRock's
    // `drLuke` / `rockPattern` methods (hence the libraryPick closure).
    const blueprint = generateAlgoBlueprint(rng, style.algoName!, makeLibraryPick(bank, rng));
    return {
      styleName,
      blueprintIndex: -1,
      blueprint,
      blueprintBars: blueprintBars(blueprint),
      laneMidi: style.laneMidi,
    };
  }

  const blueprintIndex = rng.int(0, style.blueprints.length - 1);
  const blueprint = style.blueprints[blueprintIndex]!;
  return {
    styleName,
    blueprintIndex,
    blueprint,
    blueprintBars: blueprintBars(blueprint),
    laneMidi: style.laneMidi,
  };
}

/** What the pattern lab previews: proposed blueprints, or a proposed
 *  Casperaki-written generator, forced in place of the genre's styles. */
export type DrumPreview =
  | { readonly kind: 'blueprints'; readonly blueprints: readonly DrumBlueprint[] }
  | { readonly kind: 'algo'; readonly algo: string };

/** Pick a blueprint from a pattern-lab preview instead of the genre's styles. */
export function selectPreviewDrumBlueprint(rng: Rng, preview: DrumPreview): DrumBankSelection {
  const bank = loadBank();
  const laneMidi = bank.styles.values().next().value!.laneMidi;
  let blueprint: DrumBlueprint;
  let blueprintIndex = -1;
  if (preview.kind === 'algo') {
    const gen = AUTHORED_DRUM_ALGOS[preview.algo];
    if (!gen) throw new Error(`unknown authored drum generator "${preview.algo}"`);
    blueprint = gen(rng, makeLibraryPick(bank, rng));
  } else {
    if (preview.blueprints.length === 0) throw new Error('drum preview has no blueprints');
    blueprintIndex = rng.int(0, preview.blueprints.length - 1);
    blueprint = preview.blueprints[blueprintIndex]!;
  }
  for (const lane of Object.keys(blueprint)) {
    if (laneMidi[lane] === undefined) throw new Error(`drum preview uses unknown lane "${lane}"`);
  }
  return { styleName: 'preview', blueprintIndex, blueprint, blueprintBars: blueprintBars(blueprint), laneMidi };
}

/** Lane names a drum blueprint may use (bank-index.json's lanes). */
export function drumLaneNames(): readonly string[] {
  return Object.keys(loadBank().index.lanes);
}

/** Picks a random blueprint from a LIBRARY style (for popRock's drLuke/rock). */
function makeLibraryPick(bank: ResolvedBank, rng: Rng): LibraryPick {
  return (libStyleName: string): DrumBlueprint => {
    const lib = bank.styles.get(libStyleName);
    if (!lib || lib.kind !== 'library' || lib.blueprints.length === 0) {
      throw new DataAssetError(
        BANK_INDEX_META,
        `algo style requested library blueprint from "${libStyleName}", but no such library style is loaded`,
      );
    }
    return lib.blueprints[rng.int(0, lib.blueprints.length - 1)]!;
  };
}

export const BEATS_PER_LEGACY_BAR = BEATS_PER_BAR_LEGACY;

/** Re-exported for callers that want to inspect the manifest without going through selection. */
export function describeDrumBank(): {
  styles: readonly string[];
  genreStyles: Readonly<Record<string, readonly string[]>>;
  lanes: Readonly<Record<string, number>>;
} {
  const bank = loadBank();
  const lanes: Record<string, number> = {};
  for (const [name, { midi }] of Object.entries(bank.index.lanes)) lanes[name] = midi;
  const genreStyles: Record<string, readonly string[]> = {};
  for (const [g, s] of Object.entries(bank.index.genreStyles)) genreStyles[g] = [...s];
  return {
    styles: [...bank.styles.keys()],
    genreStyles,
    lanes,
  };
}
