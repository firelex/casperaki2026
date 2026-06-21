// Seeded PRNG — sole source of randomness in the brain.
//
// `mulberry32` chosen for: deterministic, fast (zero alloc per draw),
// passable distribution for musical use (we are not doing crypto), trivially
// portable between TS/Go/Rust if we ever rewrite, and small enough to read
// in one screen. Every generator threads an `Rng` instance through its call
// graph; the orchestrator constructs the initial Rng from the user-supplied
// seed and passes it down. Generators that need independent streams call
// `rng.fork(salt)` so reordering one generator doesn't shuffle others.

export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max] inclusive on both ends. */
  int(min: number, max: number): number;
  /** Uniform pick from a non-empty array. */
  pick<T>(values: readonly T[]): T;
  /** Weighted pick. `weights[i]` is the unnormalised weight for `values[i]`. */
  pickWeighted<T>(values: readonly T[], weights: readonly number[]): T;
  /** `p` probability of true. */
  bool(p?: number): boolean;
  /** Returns a new Rng deterministically derived from this one + `salt`. */
  fork(salt: string | number): Rng;
}

export function createRng(seed: number | string): Rng {
  let s = normalizeSeed(seed) >>> 0;
  return makeRng(s);
}

function normalizeSeed(seed: number | string): number {
  if (typeof seed === 'number') return Math.floor(seed) | 0;
  // FNV-1a over UTF-16 code units — deterministic, no hidden state.
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

function makeRng(initialState: number): Rng {
  let state = initialState >>> 0;
  const next = (): number => {
    // mulberry32 step
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int(min, max) {
      if (max < min) throw new Error(`Rng.int: max(${max}) < min(${min})`);
      const range = max - min + 1;
      return min + Math.floor(next() * range);
    },
    pick(values) {
      if (values.length === 0) throw new Error('Rng.pick: empty array');
      return values[Math.floor(next() * values.length)]!;
    },
    pickWeighted(values, weights) {
      if (values.length === 0) throw new Error('Rng.pickWeighted: empty array');
      if (values.length !== weights.length)
        throw new Error('Rng.pickWeighted: values and weights length mismatch');
      let total = 0;
      for (const w of weights) {
        if (w < 0) throw new Error('Rng.pickWeighted: negative weight');
        total += w;
      }
      if (total <= 0) throw new Error('Rng.pickWeighted: total weight is zero');
      let r = next() * total;
      for (let i = 0; i < values.length; i++) {
        r -= weights[i]!;
        if (r < 0) return values[i]!;
      }
      return values[values.length - 1]!;
    },
    bool(p = 0.5) {
      return next() < p;
    },
    fork(salt) {
      const saltSeed = normalizeSeed(typeof salt === 'number' ? salt : `${salt}`);
      return makeRng((state ^ saltSeed) >>> 0);
    },
  };
}
