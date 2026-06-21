// Helpers shared by golden tests. Centralises seed list + golden path
// shape so the `test:goldens:update` script and the spec stay in lockstep.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export const FIXTURES_ROOT = resolve(HERE, 'fixtures');
export const STRUCTURE_GOLDEN_DIR = resolve(FIXTURES_ROOT, 'golden', 'structure');
export const CHORDS_GOLDEN_DIR = resolve(FIXTURES_ROOT, 'golden', 'chords');
export const SELECTION_GOLDEN_DIR = resolve(FIXTURES_ROOT, 'golden', 'selection');
export const PATTERNS_GOLDEN_DIR = resolve(FIXTURES_ROOT, 'golden', 'patterns');
export const VOCALS_GOLDEN_DIR = resolve(FIXTURES_ROOT, 'golden', 'vocals');
export const ORCHESTRATE_GOLDEN_DIR = resolve(FIXTURES_ROOT, 'golden', 'orchestrate');

export interface GoldenCase {
  readonly genre: 'brightPop' | 'edm';
  readonly seed: string;
  readonly key: string;
  /** Generator BPM. brightPop uses 120; the edm slice uses 128 (canonical EDM tempo). */
  readonly bpm?: number;
}

// docs/56b — the edm vertical slice is golden-tested at the orchestrate
// level only. Per-step goldens (structure / chords / selection / patterns
// / vocals) stay brightPop-only to keep the test matrix small; the
// orchestrate golden + dedicated edm specs cover edm determinism.
const BRIGHTPOP_CASE: GoldenCase = {
  genre: 'brightPop', seed: 'brightPop-vertical-slice', key: 'C', bpm: 120,
};
const EDM_CASE: GoldenCase = {
  genre: 'edm', seed: 'edm-vertical-slice', key: 'C', bpm: 128,
};

export const STRUCTURE_GOLDEN_CASES: readonly GoldenCase[] = [BRIGHTPOP_CASE];
export const CHORDS_GOLDEN_CASES: readonly GoldenCase[] = [BRIGHTPOP_CASE];
export const SELECTION_GOLDEN_CASES: readonly GoldenCase[] = [BRIGHTPOP_CASE];
export const PATTERNS_GOLDEN_CASES: readonly GoldenCase[] = [BRIGHTPOP_CASE];
export const VOCALS_GOLDEN_CASES: readonly GoldenCase[] = [BRIGHTPOP_CASE];
export const ORCHESTRATE_GOLDEN_CASES: readonly GoldenCase[] = [BRIGHTPOP_CASE, EDM_CASE];

export function structureGoldenPath(genre: string, seed: string): string {
  return resolve(STRUCTURE_GOLDEN_DIR, genre, `${seed}.json`);
}

export function chordsGoldenPath(genre: string, seed: string): string {
  return resolve(CHORDS_GOLDEN_DIR, genre, `${seed}.json`);
}

export function selectionGoldenPath(genre: string, seed: string): string {
  return resolve(SELECTION_GOLDEN_DIR, genre, `${seed}.json`);
}

export function patternsGoldenPath(genre: string, seed: string): string {
  return resolve(PATTERNS_GOLDEN_DIR, genre, `${seed}.json`);
}

export function vocalsGoldenPath(genre: string, seed: string): string {
  return resolve(VOCALS_GOLDEN_DIR, genre, `${seed}.json`);
}

export function orchestrateGoldenPath(genre: string, seed: string): string {
  return resolve(ORCHESTRATE_GOLDEN_DIR, genre, `${seed}.song.json`);
}
