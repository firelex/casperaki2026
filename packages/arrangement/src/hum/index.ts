// "Hum to song": the pieces that live in the arrangement package.
//
//   - The chord fitter (chord-fit.ts, chords.ts; moved here from apps/models/chord-fit, which evaluates it and
//     writes data/hum/chord-fit-model.json): chords for a hummed melody, three alternatives.
//   - `loadChordFitModel()`: the trained prior, known progressions and tuned parameters, validated.
//   - The user's chorus (user-chorus.ts): a hummed melody and its chords handed to song generation, which then
//     sings it as the chorus instead of a borrowed precedent.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import type { HarmonizeParams, KnownProgression, Prior } from './chord-fit.js';

export * from './chord-fit.js';
export * from './chords.js';
export * from './user-chorus.js';

const MODEL_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'hum', 'chord-fit-model.json');

const ChordFitModelSchema = z.object({
  $description: z.string(),
  params: z.object({
    fit: z.object({ alpha: z.number(), rootBonus: z.number(), carryWeight: z.number(), passingWeight: z.number() }).strict(),
    lambda: z.number(),
    delta: z.number(),
    fill: z.enum(['tile', 'empty']),
    knownRank: z.enum(['fit', 'score']),
  }).strict(),
  fillByMelodyBars: z.record(z.string(), z.enum(['tile', 'empty'])),
  prior: z.object({
    vocab: z.array(z.string()),
    init: z.array(z.number()),
    within: z.array(z.array(z.number())),
    across: z.array(z.array(z.number())),
  }).strict(),
  known: z.array(z.object({ name: z.string(), slots: z.array(z.string()).length(16) }).strict()).min(2),
}).strict();

export interface ChordFitModel {
  readonly params: HarmonizeParams;
  readonly fillByMelodyBars: Readonly<Record<string, 'tile' | 'empty'>>;
  readonly prior: Prior;
  readonly known: readonly KnownProgression[];
}

let cached: ChordFitModel | undefined;

/** The chord fitter's trained model (data/hum/chord-fit-model.json), read once. */
export function loadChordFitModel(): ChordFitModel {
  if (cached) return cached;
  const parsed = ChordFitModelSchema.safeParse(JSON.parse(readFileSync(MODEL_PATH, 'utf8')));
  if (!parsed.success) throw new Error(`loadChordFitModel: ${MODEL_PATH} is not a valid chord-fit model: ${parsed.error.message}`);
  cached = parsed.data;
  return cached;
}
