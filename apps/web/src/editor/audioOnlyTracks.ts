import type { Song } from '@casperaki/song-schema';

/**
 * Tracks that are audio only: instruments that sung takes (song.aiArtifacts) are attached to but that have no
 * instrument definition, such as "Ad-libs". They have clips and no notes. In order of first appearance.
 */
export function audioOnlyTracks(song: Pick<Song, 'aiArtifacts' | 'instrumentDefinitions'>): string[] {
  const defined = new Set(song.instrumentDefinitions.map((d) => d.name));
  const names: string[] = [];
  for (const a of song.aiArtifacts) {
    const at = a.attachedTo;
    if (at.scope !== 'segment' || at.instrument === undefined) continue;
    if (!defined.has(at.instrument) && !names.includes(at.instrument)) names.push(at.instrument);
  }
  return names;
}
