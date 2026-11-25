import { createHash } from 'node:crypto';
import type { Song } from './schemas/song.js';
import type { AIArtifact } from './schemas/ai-artifact.js';
import { stableStringify } from './canonical/stringify.js';

export const SUNG_TAKE_KINDS = ['yue2-vocal', 'soulx-vocal'] as const;

// What a sung take was sung over: tempo, the section's bars with chords, and
// the track's lane in that section. A change to any of these makes the take stale.
export function vocalTakeFingerprint(song: Song, segment: string, track: string): string {
  const section = song.songStructure.find((s) => s.name === segment);
  if (!section) throw new Error(`vocalTakeFingerprint: song has no segment "${segment}" in songStructure`);
  const payload = song.arrangement[segment];
  if (!payload) throw new Error(`vocalTakeFingerprint: song has no arrangement for segment "${segment}"`);
  const canonical = stableStringify({
    bpm: song.bpm,
    bars: section.bars,
    lane: payload.overrides[track] ?? null,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function isTakeFresh(song: Song, artifact: AIArtifact): boolean {
  const at = artifact.attachedTo;
  if (at.scope !== 'segment' || at.instrument === undefined) {
    throw new Error(`isTakeFresh: artifact "${artifact.id}" is not attached to a segment and instrument`);
  }
  const stored = artifact.conditioning?.hashes?.[0];
  if (stored === undefined) {
    throw new Error(`isTakeFresh: artifact "${artifact.id}" has no conditioning.hashes[0] fingerprint`);
  }
  return stored === vocalTakeFingerprint(song, at.segment, at.instrument);
}
