// Step 4 — per-style song-structure generator.
//
// Picks a structure precedent from the genre-appropriate pool, then applies
// the legacy `SongStructureClass.getSongStructure` rules:
//   - schlager genres draw from `schlagerSongStructures.json`;
//     every other canonical genre draws from `songStructures.json`.
//   - If the precedent has no `intro`, prepend one (4 bars). For non-
//     schlager genres this is unconditional; for schlager it's a coin
//     flip.
//   - For every `break*` segment, the legacy code collapses its bar count
//     to either 1 or 2 (a uniform pick).
//   - For genre === 'edm', segment lengths greater than 4 are snapped
//     down to the nearest multiple of 4; greater than 8 to the nearest
//     multiple of 8.
//   - If the precedent has no `outro`, a 50% coin flip appends one of
//     length 4 or 8 (uniform pick when added).
//
// Determinism: every RNG draw comes from `ctx.rng.fork('structure')` in a
// fixed call order — precedent pick → (schlager only: intro flip) →
// per-break collapses (in segment iteration order) → outro flip →
// (outro length pick if added). Same seed → byte-identical structure.
//
// Output segment names match the legacy lowercase camelCase convention
// (`intro`, `verse1`, `preChorus1`, `chorus1`, `break1`, `bridge1`,
// `outro`, etc.). The chord generator's precedent file must use the same
// keys.

import { GenreSchema, type Genre } from '@casperaki/song-schema';
import type { Segment, SongStructure } from '@casperaki/song-schema';
import type { Rng } from '@casperaki/music-theory';

import type { GeneratorContext } from '../context.js';
import { loadStructurePools, type StructurePrecedent } from './data.js';

export function generateSongStructure(ctx: GeneratorContext): SongStructure {
  const genre = parseGenre(ctx.params.genre);
  const rng = ctx.rng.fork('structure');
  const pools = loadStructurePools();
  const pool: readonly StructurePrecedent[] =
    genre === 'schlager' ? pools.schlager : pools.default;

  // 1. Pick a precedent.
  const precedent = rng.pick(pool);
  const segments = precedent.segments;

  const out: Segment[] = [];

  // 2. Optional intro prepend.
  const hasIntro = Object.prototype.hasOwnProperty.call(segments, 'intro');
  if (!hasIntro) {
    const shouldPrepend = genre === 'schlager' ? rng.bool() : true;
    if (shouldPrepend) out.push(buildSegment('intro', 4));
  }

  // 3. Walk the precedent in insertion order, applying break + edm rules.
  for (const [name, lengthInBars] of Object.entries(segments)) {
    let bars = lengthInBars;
    const segmentType = baseType(name);
    if (segmentType === 'break') {
      // Legacy: only the 2/4/8 cases were rewritten — preserve.
      if (bars === 2 || bars === 4 || bars === 8) {
        bars = rng.pick([1, 2]);
      }
    }
    if (genre === 'edm') bars = snapEdmBars(bars);
    out.push(buildSegment(name, bars));
  }

  // 4. Optional outro append.
  const hasOutro = Object.prototype.hasOwnProperty.call(segments, 'outro');
  if (!hasOutro) {
    const shouldAppend = rng.bool();
    if (shouldAppend) {
      const outroBars = rng.pick([4, 8]);
      out.push(buildSegment('outro', outroBars));
    }
  }

  return out;
}

function parseGenre(raw: string): Genre {
  const r = GenreSchema.safeParse(raw);
  if (!r.success) {
    throw new Error(
      `generateSongStructure: unsupported genre "${raw}" — canonical genres are: ` +
      GenreSchema.options.join(', '),
    );
  }
  return r.data;
}

/** First contiguous letter run of a segment name. `verse1` → `verse`,
 *  `preChorus2` → `preChorus`, `break3` → `break`. Mirrors the legacy
 *  `segment.match(/[^0-9]+/)[0]` idiom. */
function baseType(name: string): string {
  const m = /^[^0-9]+/u.exec(name);
  return m ? m[0]! : name;
}

/** Legacy edm rule (`SongStructureClass.js` lines 129-141). */
function snapEdmBars(bars: number): number {
  if (bars > 8) return bars - (bars % 8);
  if (bars > 4) return bars - (bars % 4);
  return bars;
}

function buildSegment(name: string, barCount: number): Segment {
  return {
    name,
    bars: Array.from({ length: barCount }, () => ({ chords: [] })),
  };
}

// Re-export the loader so callers (e.g. test helpers) can introspect the
// pool sizes without re-implementing the loader.
export { loadStructurePools } from './data.js';
export type { StructurePools, StructurePrecedent } from './data.js';

// `Rng` is part of the public type surface (a future-step caller may want
// to pre-fork and replay) so we re-export the underlying alias too.
export type { Rng };
