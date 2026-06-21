// Time: bar/beat arithmetic used by every generator.
//
// The engine's notes are keyed by beat-position-within-segment-bar as
// stringified decimals: "0.0", "0.5", "2.75". We treat positions as
// floats internally and stringify them only when emitting the engine
// envelope through `@casperaki/song-schema`. `formatBarBeat` produces
// the canonical form (always `<integer>.<decimal>`, no trailing zeros
// except a single `.0` for integer beats).

const BEATS_PER_BAR = 4; // brain only supports 4/4 today; the engine ditto

export function beatsPerBar(): number {
  return BEATS_PER_BAR;
}

/** Format a beat offset as the engine's bar-position key. */
export function formatBarBeat(beat: number): string {
  if (!Number.isFinite(beat)) throw new Error(`formatBarBeat: non-finite ${beat}`);
  if (beat === 0) return '0.0';
  // Strip trailing zeros, but keep at least one decimal digit.
  let s = beat.toFixed(8).replace(/0+$/u, '');
  if (s.endsWith('.')) s += '0';
  return s;
}

/** Parse a "0.5"-style key back to a float. */
export function parseBarBeat(key: string): number {
  const n = Number.parseFloat(key);
  if (!Number.isFinite(n)) throw new Error(`parseBarBeat: cannot parse "${key}"`);
  return n;
}

/** Bars × beats-per-bar = total beats. */
export function barsToBeats(bars: number): number {
  return bars * BEATS_PER_BAR;
}

/** Bars × beats-per-bar × (60 / bpm) = total seconds. */
export function barsToSeconds(bars: number, bpm: number): number {
  if (bpm <= 0) throw new Error(`barsToSeconds: bpm ${bpm} must be positive`);
  return (bars * BEATS_PER_BAR * 60) / bpm;
}
