import type { Song } from '../schemas/song.js';

// Normalize a parsed Song to its canonical in-memory shape. Idempotent.
// Today this is mostly about BarBeat string normalization: the engine reads
// "0", "0.0", "0.00" identically, so we collapse them to a single form
// before stringify so two semantically-equal songs hash identically.
export function normalizeSong(song: Song): Song {
  const next = structuredClone(song) as Song;
  for (const [, payload] of Object.entries(next.arrangement)) {
    if (!payload.overrides) continue;
    for (const [, override] of Object.entries(payload.overrides)) {
      if (!override.bars) continue;
      for (const bar of override.bars) {
        if (!bar.notes) continue;
        (bar as { notes?: Record<string, unknown[]> }).notes = normalizeBarNotes(
          bar.notes as unknown as Record<string, unknown[]>,
        );
      }
    }
  }
  return next;
}

function normalizeBarNotes(notes: Record<string, unknown[]>): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const key of Object.keys(notes)) {
    out[normalizeBarBeatKey(key)] = notes[key];
  }
  return out;
}

export function normalizeBarBeatKey(key: string): string {
  if (!/^-?\d+(?:\.\d+)?$/u.test(key)) return key;
  const num = Number(key);
  if (Number.isInteger(num)) return `${num}.0`;
  // Trim trailing zeros from the fractional part but keep at least one digit.
  const fixed = num.toString();
  if (!fixed.includes('.')) return `${fixed}.0`;
  return fixed.replace(/0+$/u, '').replace(/\.$/u, '.0');
}
