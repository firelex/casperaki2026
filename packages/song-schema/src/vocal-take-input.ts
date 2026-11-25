import type { Song } from './schemas/song.js';
import { stableStringify } from './canonical/stringify.js';

// No node:crypto here, so browsers can import this file ("@casperaki/song-schema/vocal-take-input") and hash the
// canonical text with their own SHA-256 (vocalTakeFingerprint hashes the same text).
export const SUNG_TAKE_KINDS = ['yue2-vocal', 'soulx-vocal'] as const;

/** The text a sung take's fingerprint is the SHA-256 of: tempo, the section's bars, and the track's lane in it. */
export function vocalTakeCanonical(song: Song, segment: string, track: string): string {
  const section = song.songStructure.find((s) => s.name === segment);
  if (!section) throw new Error(`vocalTakeFingerprint: song has no segment "${segment}" in songStructure`);
  const payload = song.arrangement[segment];
  if (!payload) throw new Error(`vocalTakeFingerprint: song has no arrangement for segment "${segment}"`);
  return stableStringify({
    bpm: song.bpm,
    bars: section.bars,
    lane: payload.overrides[track] ?? null,
  });
}
