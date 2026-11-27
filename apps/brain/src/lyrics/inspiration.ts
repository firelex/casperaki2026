// Inspiration for lyrics written first (docs/superpowers/specs/2026-11-27-lyrics-first-singing-design.md, step 1):
// per song, a current pop artist whose way of writing the lyrics follow (a style cue only: no line of theirs is ever
// shown or reused) and a situation the song is about. In the test of 2026-11-27 the situation was what broke the
// model's habit of telling the same story every time. The situations are data (situations.json, written once by
// scripts/write-situations.ts, pruned by the owner when convenient).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

export const ARTISTS: readonly string[] = [
  'Katy Perry',
  'Kesha',
  'Olivia Rodrigo',
  'Ed Sheeran',
  'Dua Lipa',
  'Taylor Swift',
  'Sabrina Carpenter',
  'Harry Styles',
  'Charli XCX',
  'Ariana Grande',
  'Lizzo',
  'The Weeknd',
];

export const SITUATIONS_FILE = join(dirname(fileURLToPath(import.meta.url)), 'situations.json');
const SituationsSchema = z.array(z.string().trim().min(8)).min(150);

let cached: readonly string[] | undefined;
/** The situations a song may be about. */
export function situations(): readonly string[] {
  cached ??= SituationsSchema.parse(JSON.parse(readFileSync(SITUATIONS_FILE, 'utf8')));
  return cached;
}

/** One artist and one situation (`random`: a number in [0, 1), Math.random in use). */
export function drawInspiration(random: () => number): { artist: string; situation: string } {
  const pick = <T>(xs: readonly T[]): T => xs[Math.min(xs.length - 1, Math.floor(random() * xs.length))]!;
  return { artist: pick(ARTISTS), situation: pick(situations()) };
}
