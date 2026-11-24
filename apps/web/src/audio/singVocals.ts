// Sung vocals on the song (docs/superpowers/specs/2026-11-24-sung-vocals-design.md): the setting, the takes
// recorded as aiArtifacts, and singing the sections whose take is missing or stale before the song plays.

import type { AIArtifact, Song } from '@casperaki/song-schema';

import type { SectionStatus } from '../api/vocals';

const isVocalTake = (a: AIArtifact, segment?: string) =>
  a.kind === 'soulx-vocal' && a.attachedTo.scope === 'segment' && a.attachedTo.instrument === 'Vocal' && (segment === undefined || a.attachedTo.segment === segment);

/** The song with `take` as its section's lead vocal take (any earlier take of that section replaced). */
export function withTake(song: Song, take: AIArtifact): Song {
  if (take.attachedTo.scope !== 'segment') throw new Error('withTake: a vocal take is attached to a section');
  const segment = take.attachedTo.segment;
  return { ...song, aiArtifacts: [...song.aiArtifacts.filter((a) => !isVocalTake(a, segment)), take] };
}

/** Vocals on (with a voice) or off; take numbers are kept. */
export function withVocals(song: Song, enabled: boolean, voice?: string): Song {
  const v = voice ?? song.vocals?.voice;
  if (!v) throw new Error('withVocals: switching vocals on needs a voice');
  return { ...song, vocals: { enabled, voice: v, takeNumbers: song.vocals?.takeNumbers ?? {} } };
}

/** The voice changed (every section is sung again with it on the next play). */
export function withVoice(song: Song, voice: string): Song {
  if (!song.vocals) throw new Error('withVoice: the song has no vocals setting');
  return { ...song, vocals: { ...song.vocals, voice } };
}

/** A fresh take of these sections on the next play: their take numbers go up by one. */
export function singAgain(song: Song, segments: string | readonly string[]): Song {
  if (!song.vocals) throw new Error('singAgain: the song has no vocals setting');
  const takeNumbers = { ...song.vocals.takeNumbers };
  for (const s of typeof segments === 'string' ? [segments] : segments) takeNumbers[s] = (takeNumbers[s] ?? 1) + 1;
  return { ...song, vocals: { ...song.vocals, takeNumbers } };
}

export interface SingApi {
  status(song: Song, signal?: AbortSignal): Promise<{ sections: SectionStatus[] }>;
  sing(song: Song, segment: string, signal?: AbortSignal): Promise<{ artifact: AIArtifact }>;
}

/**
 * Sings every section whose take is missing or stale, one after another ("Singing chorus1 (2 of 3)"), and returns
 * the song with the new takes; the same song when nothing needed singing. A failure throws (the caller shows it).
 */
export async function singMissing(song: Song, api: SingApi, onProgress: (text: string) => void, signal?: AbortSignal): Promise<Song> {
  const todo = (await api.status(song, signal)).sections.filter((s) => s.state === 'missing' || s.state === 'stale').map((s) => s.segment);
  let out = song;
  for (const [i, segment] of todo.entries()) {
    onProgress(`Singing ${segment} (${i + 1} of ${todo.length})`);
    const { artifact } = await api.sing(song, segment, signal);
    out = withTake(out, artifact);
  }
  return out;
}
