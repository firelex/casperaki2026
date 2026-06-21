// Cached loader for the arrangement-polish bank files (fills.json + rules.json).
//
// Both files are hand-authored manifests that encode legacy rules from
// `services/classes/arrangements/instruments/{drums,transitions}.js` plus a
// small slice of the `FillGeneratorClass` ASCII-grid fill bank. See
// docs/53aa-step16-arrangement-polish-import.md for legacy provenance.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { DataAssetError, type DataAssetMeta } from '../data/loader.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(HERE, '..', '..', 'data', 'arrangement-polish');

// ---- fills.json ----

const GridSchema = z
  .string()
  .regex(/^[x\-0\s]+$/u, 'fill grid must be x / - / 0 characters (spaces allowed)');

// One legacy `_addHits` call: pick a lane from `lanes` and a grid from `grids`
// (both uniform `selectRandomly` pools) and overlay it at `beat`.
const FillAddSchema = z
  .object({
    lanes: z.array(z.string().min(1)).min(1),
    beat: z.number().int(),
    grids: z.array(GridSchema).min(1),
  })
  .strict();

// A step is either an unconditional `add` or a `choice`: legacy
// `Tools.selectRandomly([0..count-1])` — apply the matched case's adds, or
// nothing if the rolled index has no case (e.g. the `case 0` / unlisted no-op).
const FillStepSchema = z.union([
  z.object({ add: FillAddSchema }).strict(),
  z
    .object({
      choice: z
        .object({
          count: z.number().int().positive(),
          cases: z.record(z.string().min(1), z.array(FillAddSchema).min(1)),
        })
        .strict(),
    })
    .strict(),
]);

const FillVariantSchema = z
  .object({
    weight: z.number().int().positive().optional(),
    composeFrom: z.enum(['mediumFill']).optional(),
    steps: z.array(FillStepSchema).min(1),
  })
  .strict();

const FillStyleBranchesSchema = z
  .object({
    edm: z.array(FillVariantSchema).min(1),
    default: z.array(FillVariantSchema).min(1),
  })
  .strict();

const FillCategoriesSchema = z.object({
  smallFill: FillStyleBranchesSchema,
  mediumFill: FillStyleBranchesSchema,
  bigFill: FillStyleBranchesSchema,
});

const FillsFileSchema = z
  .object({
    $schemaVersion: z.literal(1),
    $gridLength: z.number().int().positive(),
    categories: FillCategoriesSchema,
  })
  .passthrough();

export type FillCategory = 'smallFill' | 'mediumFill' | 'bigFill';
export type FillStyleBranch = 'edm' | 'default';
export type FillAdd = z.infer<typeof FillAddSchema>;
export type FillStep = z.infer<typeof FillStepSchema>;
export type FillVariant = z.infer<typeof FillVariantSchema>;

export interface FillBank {
  readonly gridLength: number;
  readonly categories: Readonly<
    Record<FillCategory, Readonly<Record<FillStyleBranch, readonly FillVariant[]>>>
  >;
}

const FILLS_META: DataAssetMeta = {
  filename: 'fills.json',
  legacyPath:
    'casperaki2-engine-js/api/v1.0/services/classes/patterns/drumPatterns/FillGeneratorClass.js (_addSmallFill / _addMediumFill / _addBigFill)',
  extractedAt: '2026-06-06',
};

// ---- rules.json ----

// docs/62 A1 — a fill slot value is either a constant category ('smallFill',
// 0 RNG draws, = legacy constant assignment) or a pool to pick from
// (['mediumFill','bigFill'], 1 `selectRandomly` draw — even a length-1 array,
// since legacy `selectRandomly(['bigFill'])` still draws).
const FillCategoryRefSchema = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

const FillByNextSchema = z.record(z.string().min(1), FillCategoryRefSchema);

const FillInnerRuleSchema = z
  .object({
    patternFourthBar: FillCategoryRefSchema.nullable().optional(),
    patternTwelfthBar: FillCategoryRefSchema.nullable().optional(),
    patternMiddleOfSegment: FillCategoryRefSchema.nullable().optional(),
    patternEndOfSegment: FillCategoryRefSchema.nullable().optional(),
    patternEndOfSegmentByNext: FillByNextSchema.optional(),
  })
  .passthrough();

// docs/62 A1 — per segment-type, fill PLACEMENT splits by genre into a `rich`
// branch (latin/organicVibes/rock — legacy `_getFill`'s [latin,organicVibes,
// rock] gate) and a `default` branch (edm/brightPop/schlager). `intro` uses the
// `$introSpecial` coin logic in fills.ts (rock always; latin/organicVibes coin).
const FillSegmentRuleSchema = z
  .object({
    rich: FillInnerRuleSchema.optional(),
    default: FillInnerRuleSchema.optional(),
    $introSpecial: z.boolean().optional(),
  })
  .passthrough();

const TransitionSegmentRuleSchema = z
  .object({
    anyGenre: z.array(z.string().min(1)).optional(),
    brightPopExtra: z.array(z.string().min(1)).optional(),
    brightPopExtraAlways: z.array(z.string().min(1)).optional(),
    beginningAnyGenre: z.array(z.string().min(1)).optional(),
    beginningBrightPopExtra: z.array(z.string().min(1)).optional(),
    endAnyGenre: z.array(z.string().min(1)).optional(),
    endBrightPopExtra: z.array(z.string().min(1)).optional(),
    midBrightPopByNext: z.record(z.string().min(1), z.string().min(1)).optional(),
  })
  .passthrough();

const SignalProcessorChoiceSchema = z.object({
  type: z.string().min(1),
  weight: z.number().int().positive(),
});

const RulesFileSchema = z
  .object({
    $schemaVersion: z.literal(1),
    fillStylesByGenre: z.array(z.string().min(1)).min(1),
    fills: z.record(z.string().min(1), FillSegmentRuleSchema),
    transitions: z.record(z.string().min(1), TransitionSegmentRuleSchema.or(z.unknown())),
    signalProcessors: z
      .record(z.string().min(1), z.array(SignalProcessorChoiceSchema).min(1).or(z.unknown())),
  })
  .passthrough();

const RULES_META: DataAssetMeta = {
  filename: 'rules.json',
  legacyPath:
    'casperaki2-engine-js/api/v1.0/services/classes/arrangements/instruments/{drums,transitions}.js',
  extractedAt: '2026-06-06',
};

export type FillSegmentRule = z.infer<typeof FillSegmentRuleSchema>;
export type FillInnerRule = z.infer<typeof FillInnerRuleSchema>;
export type TransitionSegmentRule = z.infer<typeof TransitionSegmentRuleSchema>;
export type SignalProcessorChoice = z.infer<typeof SignalProcessorChoiceSchema>;

export interface ArrangementRules {
  readonly fillStylesByGenre: readonly string[];
  readonly fills: Readonly<Record<string, FillSegmentRule>>;
  readonly transitions: Readonly<Record<string, TransitionSegmentRule>>;
  readonly signalProcessors: Readonly<Record<string, readonly SignalProcessorChoice[]>>;
}

// ---- cached loaders ----

let cachedFills: FillBank | undefined;
let cachedRules: ArrangementRules | undefined;

function loadFile<T>(meta: DataAssetMeta, schema: z.ZodSchema<T>): T {
  const path = resolve(DATA_DIR, meta.filename);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new DataAssetError(meta, `failed to load: ${(err as Error).message}`, err);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new DataAssetError(
      meta,
      `manifest is malformed: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
    );
  }
  return parsed.data;
}

export function loadFillBank(): FillBank {
  if (cachedFills) return cachedFills;
  const data = loadFile(FILLS_META, FillsFileSchema);
  const freezeBranch = (branch: { edm: FillVariant[]; default: FillVariant[] }) => ({
    edm: branch.edm.map((v) => Object.freeze(v) as FillVariant),
    default: branch.default.map((v) => Object.freeze(v) as FillVariant),
  });
  cachedFills = {
    gridLength: data.$gridLength,
    categories: {
      smallFill: freezeBranch(data.categories.smallFill),
      mediumFill: freezeBranch(data.categories.mediumFill),
      bigFill: freezeBranch(data.categories.bigFill),
    },
  };
  return cachedFills;
}

export function loadArrangementRules(): ArrangementRules {
  if (cachedRules) return cachedRules;
  const data = loadFile(RULES_META, RulesFileSchema);
  const sp: Record<string, readonly SignalProcessorChoice[]> = {};
  for (const [k, v] of Object.entries(data.signalProcessors)) {
    if (Array.isArray(v)) sp[k] = v as SignalProcessorChoice[];
  }
  const tr: Record<string, TransitionSegmentRule> = {};
  for (const [k, v] of Object.entries(data.transitions)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) tr[k] = v as TransitionSegmentRule;
  }
  cachedRules = {
    fillStylesByGenre: [...data.fillStylesByGenre],
    fills: data.fills,
    transitions: tr,
    signalProcessors: sp,
  };
  return cachedRules;
}

/** Test-only — drop in-memory caches so reload re-reads disk. */
export function _resetArrangementPolishCache(): void {
  cachedFills = undefined;
  cachedRules = undefined;
}
