import { createHash } from 'node:crypto';
import type { Song } from './schemas/song.js';
import type { AIArtifact } from './schemas/ai-artifact.js';
import { vocalTakeCanonical } from './vocal-take-input.js';

export { SUNG_TAKE_KINDS } from './vocal-take-input.js';

// What a sung take was sung over: tempo, the section's bars with chords, and
// the track's lane in that section. A change to any of these makes the take stale.
export function vocalTakeFingerprint(song: Song, segment: string, track: string): string {
  return createHash('sha256').update(vocalTakeCanonical(song, segment, track), 'utf8').digest('hex');
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
