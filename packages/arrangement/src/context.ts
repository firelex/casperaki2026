// Shared types every generator in @casperaki/arrangement consumes/produces.
//
// `GeneratorContext` is the value threaded down by the orchestrator: the
// seeded Rng plus the immutable parameters of the run. Individual
// generators (structure, chords, patterns, vocals) take `GeneratorContext`
// + their own input slice and return a slice of canonical Song.
//
// Determinism contract: every generator that needs randomness must
// `ctx.rng.fork(generatorName)` to get an independent stream — never call
// the parent rng directly. This way adding/removing a generator doesn't
// shift any other generator's output.

import type { Rng } from '@casperaki/music-theory';

export interface GenerateParams {
  /** Genre key. Generators validate against the canonical brain
   *  vocabulary (`GenreSchema` in @casperaki/song-schema:
   *  `ballad | brightPop | edm | latin | organicVibes | rock | schlager
   *  | urban`). Non-canonical strings (notably the Phase-3 placeholder
   *  `'pop'`) are rejected at the generator boundary — there is no
   *  compatibility alias. See docs/53o-…. */
  readonly genre: string;
  /** Tonic + mode, parseable by music-theory's parseKey ("C", "Am"). */
  readonly key: string;
  /** Beats per minute. */
  readonly bpm: number;
  /** PRNG seed — string or integer; canonicalised by createRng. */
  readonly seed: string | number;
  /** Optional generator-specific overrides; opaque blob, generators inspect their keys. */
  readonly params?: Readonly<Record<string, unknown>>;
}

export interface GeneratorContext {
  readonly rng: Rng;
  readonly params: GenerateParams;
}

/** Marker for values that depend on the seeded RNG — purely documentary today. */
export type Seeded<T> = T;
