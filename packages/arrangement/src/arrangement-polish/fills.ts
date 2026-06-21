// Drum fills — legacy-derived `_getFill` rules + a small ASCII-grid bank.
//
// Per docs/53aa-step16-arrangement-polish-import.md. Each drums-active
// segment receives a `FillBlock` keyed by drum lane — the schema's
// `FillBlockSchema` shape mirrors the legacy `FillGeneratorClass` output:
//
//   { reset: false, patterns: { patternFourthBar: { lane: '<grid>' }, ... } }
//
// The brain port stops at lowering the *placement* (which fill slot ends
// up in the FillBlock) and the *grid contents* (which clap/snare/tom variant
// was picked); the engine adapter is unchanged and currently leaves the
// FillBlock unconsumed (deferred to a later engine-bridge PR; see docs/53k
// engine-bridge inventory).

import type { Segment, SongStructure, FillBlock } from '@casperaki/song-schema';

import type { GeneratorContext } from '../context.js';
import type { Rng } from '@casperaki/music-theory';
import type { SelectionResult } from '../selection/types.js';
import {
  loadArrangementRules,
  loadFillBank,
  type FillAdd,
  type FillBank,
  type FillCategory,
  type FillInnerRule,
  type FillSegmentRule,
  type FillStyleBranch,
  type FillVariant,
} from './data.js';
import { segmentType } from './segment-type.js';

// Legacy `[ 'edm','brightPop','schlager' ].includes(parameters.style)` — these
// genres use the clap-based EDM fill GRID branch; everything else uses `default`.
const EDM_FILL_STYLE_GENRES: ReadonlySet<string> = new Set(['edm', 'brightPop', 'schlager']);

// docs/62 A1 — legacy `_getFill`'s second gate `[latin,organicVibes,rock]`
// selects the RICH placement branch (intro end-fills, chorus mediumFill|bigFill
// middle + bigFill end, break/bridge by-next end-fills). All other fill-enabled
// genres (edm/brightPop/schlager) use the leaner `default` branch. This is the
// PLACEMENT gate — orthogonal to EDM_FILL_STYLE_GENRES (the grid-bank branch).
const RICH_FILL_GENRES: ReadonlySet<string> = new Set(['latin', 'organicVibes', 'rock']);

// One bar of the legacy 32nd-note grid: 4 beats × 8 slots.
const SLOTS_PER_BAR = 32;
const SLOTS_PER_BEAT = 8;

// docs/58i — activation is now keyed by lane display name; the drums lane is
// always the essential `Drums` lane.
const DRUMS_DISPLAY_NAME = 'Drums';
const FILL_SLOTS = [
  'patternFourthBar',
  'patternTwelfthBar',
  'patternMiddleOfSegment',
  'patternEndOfSegment',
] as const;
type FillSlot = (typeof FILL_SLOTS)[number];

const FILL_CATEGORIES: readonly FillCategory[] = ['smallFill', 'mediumFill', 'bigFill'];

function isFillCategory(value: string): value is FillCategory {
  return (FILL_CATEGORIES as readonly string[]).includes(value);
}

export interface ArrangementFills {
  /** segment name → display-name → FillBlock */
  readonly bySegment: Readonly<Record<string, Readonly<Record<string, FillBlock>>>>;
}

/**
 * Build drum fills per segment. Pure: never mutates `structure` or
 * `selection`. The returned map only includes segments that actually
 * produced a non-empty fill block — callers should not emit empty entries
 * downstream.
 */
export function generateFills(
  ctx: GeneratorContext,
  structure: SongStructure,
  selection: SelectionResult,
): ArrangementFills {
  const rules = loadArrangementRules();
  const bank = loadFillBank();
  const rng = ctx.rng.fork('fills');

  if (!rules.fillStylesByGenre.includes(ctx.params.genre)) {
    return { bySegment: {} };
  }

  const activityByName = new Map(
    selection.segments.map((s) => [s.segmentName, new Set(s.activeLanes)]),
  );

  const styleBranch: FillStyleBranch = EDM_FILL_STYLE_GENRES.has(ctx.params.genre)
    ? 'edm'
    : 'default';
  const isRich = RICH_FILL_GENRES.has(ctx.params.genre);

  const bySegment: Record<string, Record<string, FillBlock>> = {};

  for (let i = 0; i < structure.length; i++) {
    const segment = structure[i]!;
    const active = activityByName.get(segment.name);
    if (!active || !active.has(DRUMS_DISPLAY_NAME)) continue;

    const type = segmentType(segment.name);
    const rule = rules.fills[type];
    if (!rule) continue;

    const nextSegment: Segment | undefined = structure[i + 1];
    const nextType = nextSegment ? segmentType(nextSegment.name) : undefined;

    const block = buildFillBlockForSegment(
      rng,
      segment,
      rule,
      bank,
      nextType,
      styleBranch,
      type,
      ctx.params.genre,
      isRich,
    );
    if (block) bySegment[segment.name] = { [DRUMS_DISPLAY_NAME]: block };
  }

  return { bySegment };
}

function buildFillBlockForSegment(
  rng: Rng,
  segment: Segment,
  rule: FillSegmentRule,
  bank: FillBank,
  nextType: string | undefined,
  styleBranch: FillStyleBranch,
  type: string,
  genre: string,
  isRich: boolean,
): FillBlock | undefined {
  const barCount = segment.bars.length;

  // docs/62 A1 — intro uses the legacy coin logic (drums.js:88-95): rock ALWAYS
  // gets an end-fill; latin/organicVibes get one on a 50% coin; edm/brightPop
  // none. The coin must be drawn for latin/organicVibes even when it lands false.
  if (type === 'intro') {
    return buildIntroFillBlock(rng, rule, bank, genre, styleBranch);
  }

  // RICH (latin/organicVibes/rock) vs default (edm/brightPop/schlager) branch.
  const inner = isRich ? rule.rich : rule.default;
  if (!inner) return undefined;

  const slotCategories: Partial<Record<FillSlot, FillCategory>> = {};
  for (const slot of FILL_SLOTS) {
    const category = resolveCategoryForSlot(slot, inner, nextType, rng);
    if (!category) continue;
    if (!slotApplies(slot, barCount)) continue;
    slotCategories[slot] = category;
  }

  if (Object.keys(slotCategories).length === 0) return undefined;

  const patterns: Record<string, Record<string, string>> = {};
  for (const slot of FILL_SLOTS) {
    const cat = slotCategories[slot];
    if (!cat) continue;
    const grids = renderFill(rng, bank, cat, styleBranch);
    if (Object.keys(grids).length > 0) patterns[slot] = grids;
  }

  return { reset: false, patterns };
}

// ---------------------------------------------------------------------------
// Legacy fill composition — port of FillGeneratorClass._add{Small,Medium,Big}Fill.
// ---------------------------------------------------------------------------

/** Weighted variant pick (legacy `selectRandomly` over a repeated array). */
function pickVariant(rng: Rng, pool: readonly FillVariant[]): FillVariant {
  let total = 0;
  for (const v of pool) total += v.weight ?? 1;
  let roll = rng.int(0, total - 1);
  for (const v of pool) {
    roll -= v.weight ?? 1;
    if (roll < 0) return v;
  }
  return pool[pool.length - 1]!;
}

/** Render one fill of `category`/`styleBranch` to a lane→grid map. */
function renderFill(
  rng: Rng,
  bank: FillBank,
  category: FillCategory,
  styleBranch: FillStyleBranch,
): Record<string, string> {
  const variant = pickVariant(rng, bank.categories[category][styleBranch]);
  const lanes: Record<string, string> = {};
  composeVariant(rng, bank, variant, styleBranch, lanes);
  // Legacy `_cleanUpDrumPattern` drops lanes that ended up all-rest.
  for (const lane of Object.keys(lanes)) {
    if (!/[x0]/u.test(lanes[lane]!)) delete lanes[lane];
  }
  return lanes;
}

function composeVariant(
  rng: Rng,
  bank: FillBank,
  variant: FillVariant,
  styleBranch: FillStyleBranch,
  lanes: Record<string, string>,
): void {
  // `expandMiddleFill` first lays down a freshly-picked mediumFill (:275).
  if (variant.composeFrom) {
    const inner = pickVariant(rng, bank.categories[variant.composeFrom][styleBranch]);
    composeVariant(rng, bank, inner, styleBranch, lanes);
  }
  for (const step of variant.steps) {
    if ('add' in step) {
      applyAdd(rng, step.add, lanes);
    } else {
      const k = rng.int(0, step.choice.count - 1);
      const adds = step.choice.cases[String(k)];
      if (adds) for (const add of adds) applyAdd(rng, add, lanes);
    }
  }
}

/** Port of legacy `_addHits`: overlay one chosen grid at slot (4+beat)*8. */
function applyAdd(rng: Rng, add: FillAdd, lanes: Record<string, string>): void {
  const lane = add.lanes[rng.int(0, add.lanes.length - 1)]!;
  const grid = add.grids[rng.int(0, add.grids.length - 1)]!.replace(/\s+/gu, '');
  const slot = (4 + add.beat) * SLOTS_PER_BEAT;
  const base = lanes[lane] ?? '-'.repeat(SLOTS_PER_BAR);
  // Legacy substring splice — a grid that runs past slot 32 grows the lane
  // string exactly as `_addHits` does (e.g. the EDM clap beat:-1 cases).
  lanes[lane] = base.slice(0, slot) + grid + base.slice(slot + grid.length);
}

/** docs/62 A1 — intro fill (legacy drums.js:88-95). rock ⇒ always end-fill;
 *  latin/organicVibes ⇒ end-fill on a 50% coin (coin drawn regardless);
 *  edm/brightPop ⇒ none. The end-fill category is picked from rule.rich's
 *  patternEndOfSegment pool (['smallFill','mediumFill']). */
function buildIntroFillBlock(
  rng: Rng,
  rule: FillSegmentRule,
  bank: FillBank,
  genre: string,
  styleBranch: FillStyleBranch,
): FillBlock | undefined {
  let place = false;
  if (genre === 'rock') {
    place = true; // legacy short-circuits `rock || (...)` — no coin for rock.
  } else if (genre === 'latin' || genre === 'organicVibes') {
    place = rng.pick([false, true]); // coin consumes a draw even when false.
  }
  if (!place) return undefined;

  const category = resolvePoolOrConst(rule.rich?.patternEndOfSegment, rng);
  if (!category) return undefined;
  const grids = renderFill(rng, bank, category, styleBranch);
  if (Object.keys(grids).length === 0) return undefined;
  return { reset: false, patterns: { patternEndOfSegment: grids } };
}

/** A fill slot value is a constant category string (0 RNG draws) or a pool to
 *  `selectRandomly` from (1 draw — including a length-1 pool, matching legacy
 *  `selectRandomly(['bigFill'])`). */
function resolvePoolOrConst(value: unknown, rng: Rng): FillCategory | undefined {
  if (typeof value === 'string') return isFillCategory(value) ? value : undefined;
  if (Array.isArray(value) && value.length > 0) {
    const choice = value[rng.int(0, value.length - 1)];
    return typeof choice === 'string' && isFillCategory(choice) ? choice : undefined;
  }
  return undefined;
}

function resolveCategoryForSlot(
  slot: FillSlot,
  inner: FillInnerRule,
  nextType: string | undefined,
  rng: Rng,
): FillCategory | undefined {
  // 1. Explicit per-slot value (constant string or pool array). `null` = no fill.
  const direct = (inner as Record<string, unknown>)[slot];
  if (direct === null) return undefined;
  if (direct !== undefined) return resolvePoolOrConst(direct, rng);

  // 2. patternEndOfSegment dispatch by next segment-type (constant or pool).
  if (slot === 'patternEndOfSegment' && inner.patternEndOfSegmentByNext) {
    const value =
      (nextType && inner.patternEndOfSegmentByNext[nextType]) ??
      inner.patternEndOfSegmentByNext['default'];
    return resolvePoolOrConst(value, rng);
  }
  return undefined;
}

function slotApplies(slot: FillSlot, barCount: number): boolean {
  // Place the fill only if the segment is long enough to host it.
  // Bar indices match the legacy 0-indexed grid placement (4th bar = index 3).
  switch (slot) {
    case 'patternFourthBar':
      return barCount >= 4;
    case 'patternTwelfthBar':
      return barCount >= 12;
    case 'patternMiddleOfSegment':
      return barCount >= 2;
    case 'patternEndOfSegment':
      return barCount >= 1;
  }
}
