import { createHash } from 'node:crypto';
import type { Song } from '../schemas/song.js';
import { canonicalStringifySong } from './stringify.js';

// sha256(canonical) — used by determinism CI and as the join key for cached
// AI artifacts that reference a procedural skeleton.
export function contentHash(song: Song): string {
  const canonical = canonicalStringifySong(song);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
