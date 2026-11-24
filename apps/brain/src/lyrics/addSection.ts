// Adding a section with its words: the generator writes the section (addSection), the lyricist writes words for
// it when it is sung, and the section is added again with them (the same section, now sung with those words).

import { addSection, sungSections } from '@casperaki/arrangement';
import type { Song } from '@casperaki/song-schema';

import { writeLyrics, type LyricModel } from './lyricist.js';

/** Thrown when a sung section is added and no lyrics model is set up. */
export class SectionWordsUnavailableError extends Error {
  constructor() {
    super('A sung section needs words, and the lyrics model is not configured (set ASSISTANT_LLM_URL and ASSISTANT_LLM_MODEL).');
    this.name = 'SectionWordsUnavailableError';
  }
}

export async function addSectionWithWords(
  song: Song,
  type: string,
  index: number,
  bars: number | undefined,
  lyricModel: LyricModel | undefined,
): Promise<{ song: Song; name: string }> {
  const first = addSection(song, type, index, bars);
  if (!sungSections(first.song).some((s) => s.name === first.name)) return first;
  if (!lyricModel) throw new SectionWordsUnavailableError();
  const words = await writeLyrics(first.song, lyricModel, { sections: [first.name] });
  return addSection(song, type, index, bars, words[first.name]);
}
