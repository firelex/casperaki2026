// Example titles for new songs (owner 2026-11-28: "the automatically chosen song titles should be more pop ... a list
// of 1,000 possible pop titles ... give DeepSeek references like we do for the lyrics"): invented chart-pop titles
// (titles.json, written once by scripts/write-titles.ts, pruned by the owner when convenient), a dozen of them shown
// to the title model for each song as the feel to aim for, never to copy.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

export const TITLES_FILE = join(dirname(fileURLToPath(import.meta.url)), 'titles.json');
export const MAX_TITLE_WORDS = 4;
/** How many example titles the model sees per song. */
export const TITLE_EXAMPLES = 12;

const TitlesSchema = z.array(z.string().trim().min(1)).min(500);

let cached: readonly string[] | undefined;
/** The bank of example titles. */
export function titleBank(): readonly string[] {
  cached ??= TitlesSchema.parse(JSON.parse(readFileSync(TITLES_FILE, 'utf8')));
  return cached;
}

/** `count` different titles of `bank`, drawn with `random` (a number in [0, 1), Math.random in use). */
export function drawTitles(bank: readonly string[], count: number, random: () => number): string[] {
  if (bank.length < count) throw new Error(`drawTitles: the bank has ${bank.length} titles, fewer than ${count}`);
  const pool = [...bank];
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const k = Math.min(pool.length - 1, Math.floor(random() * pool.length));
    out.push(pool.splice(k, 1)[0]!);
  }
  return out;
}
