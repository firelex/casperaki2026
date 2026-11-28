// What the casting writer knows about the song and the singer: plain facts it grounds the talk in.

import { GENRE_LABELS, SongGenreSchema, type Song } from '@casperaki/song-schema';

import { lyricLines, songTiming } from '../video/videoInput.js';

export interface CastingFacts {
  readonly title: string;
  /** The genre's name; null when the song has none. */
  readonly genre: string | null;
  readonly bpm: number;
  readonly tempoWord: 'slow' | 'mid-tempo' | 'fast';
  /** The song's sections in order, by name. */
  readonly sections: readonly string[];
  /** Up to four lyric lines: the first chorus's (else the song's first lines); none for a song without words. */
  readonly quotes: readonly string[];
  readonly singerName: string;
  /** What the person who added the singer wrote about the voice; null when nothing was written. */
  readonly singerDescription: string | null;
  /** The name of the avatar that performs (the singer's look). */
  readonly avatarName: string;
  /** The singer's back story as the user wrote it (who they are, who created them, where from), or null. */
  readonly backstory: string | null;
}

/** `title`: the project's title (songs keep theirs with the project). */
/** Whether a section (by its display name) is a chorus: "Chorus", "Chorus 2" — not "Pre-chorus" or "Post-chorus". */
export function isChorus(name: string): boolean {
  return /^chorus\b/iu.test(name.trim());
}

export function castingFacts(song: Song, title: string, singer: { name: string; description: string | null }, avatarName: string, backstory: string | null): CastingFacts {
  const { sections } = songTiming(song);
  const lines = lyricLines(song);
  const chorus = sections.find((s) => isChorus(s.name));
  const inChorus = chorus ? lines.filter((l) => l.startSeconds >= chorus.startSeconds && l.startSeconds < chorus.endSeconds) : [];
  const quotes = (inChorus.length > 0 ? inChorus : lines).slice(0, 4).map((l) => l.text);
  if (!title.trim()) throw new Error('casting: the song has no title; give it one first');
  let genre: string | null = null;
  if (song.genre) {
    const g = SongGenreSchema.safeParse(song.genre);
    if (!g.success) throw new Error(`casting: the song's genre "${song.genre}" is not a known genre`);
    genre = GENRE_LABELS[g.data];
  }
  return {
    title: title.trim(),
    genre,
    bpm: song.bpm,
    tempoWord: song.bpm < 95 ? 'slow' : song.bpm < 115 ? 'mid-tempo' : 'fast',
    sections: sections.map((s) => s.name),
    quotes,
    singerName: singer.name,
    singerDescription: singer.description,
    avatarName,
    backstory: backstory?.trim() ? backstory.trim() : null,
  };
}
