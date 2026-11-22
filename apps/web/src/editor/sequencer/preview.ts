import type { Song } from '@casperaki/song-schema';

/**
 * A song made of one section only, for the detail window's preview: the
 * brain lowers it (and the engine builds it) far faster than the whole
 * song, so an edit can be heard again within about a second.
 */
export function sectionSong(song: Song, sectionName: string): Song {
  const seg = song.songStructure.find((s) => s.name === sectionName);
  if (!seg) throw new Error(`Section "${sectionName}" is not in the song.`);
  const payload = song.arrangement[sectionName];
  if (!payload) throw new Error(`Section "${sectionName}" has no arrangement.`);
  return { ...song, songStructure: [seg], arrangement: { [sectionName]: payload } };
}
