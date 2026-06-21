import type { Song } from '../schemas/song.js';
import { normalizeSong } from './normalize.js';

// Serialize a Song to a byte-stable JSON string. Algorithm:
//   1. normalize() (e.g. BarBeat → "N.NNN") so semantically-equal songs
//      reach the stringifier with identical keys and value strings.
//   2. Recursively re-emit objects with sorted keys; arrays preserved
//      in their declared order (order is musically meaningful).
//   3. Numbers normalized via toJSON semantics (NaN/Infinity not allowed,
//      neg-zero collapsed to zero).
//
// Used both for determinism tests (`f(f(x)) === f(x)` byte-equal) and for
// contentHash() inputs.
export function canonicalStringifySong(song: Song, indent?: number): string {
  const normalized = normalizeSong(song);
  return stableStringify(normalized, indent);
}

export function stableStringify(value: unknown, indent?: number): string {
  return JSON.stringify(sortDeep(value), null, indent);
}

function sortDeep(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new RangeError(`canonical stringify: non-finite number ${value}`);
    }
    if (Object.is(value, -0)) return 0;
    return value;
  }
  if (Array.isArray(value)) return value.map(sortDeep);
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      const v = obj[k];
      if (v === undefined) continue;
      out[k] = sortDeep(v);
    }
    return out;
  }
  return value;
}
