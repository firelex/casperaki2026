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
  const sections = (await api.status(song, signal)).sections;
  // A stored take is not sung again: asking for it returns the stored file at once and records it.
  const todo = sections.filter((s) => s.state === 'missing' || s.state === 'stale' || s.state === 'stored').map((s) => s.segment);
  // A take left on a section that no longer has vocal notes would still play: drop it.
  const unused = new Set(sections.filter((s) => s.state === 'unused').map((s) => s.segment));
  let out = unused.size ? { ...song, aiArtifacts: song.aiArtifacts.filter((a) => !(isVocalTake(a) && a.attachedTo.scope === 'segment' && unused.has(a.attachedTo.segment))) } : song;
  for (const [i, segment] of todo.entries()) {
    onProgress(`Singing ${segment} (${i + 1} of ${todo.length})`);
    const { artifact } = await api.sing(song, segment, signal);
    out = withTake(out, artifact);
  }
  return out;
}

export type SingOutcome = { readonly kind: 'play'; readonly song: Song } | { readonly kind: 'changed' } | { readonly kind: 'cancelled' };

/**
 * Sings what Play needs, then says what to do: play the sung song; or nothing, because the run was cancelled or
 * the song on screen is no longer the one sung (another song was opened or it was edited meanwhile: the takes are
 * stored by the brain, so pressing Play again reuses them instead of overwriting the newer song).
 */
export async function singBeforePlay(
  song: Song,
  api: SingApi,
  isStillCurrent: (song: Song) => boolean,
  onProgress: (text: string) => void,
  signal: AbortSignal,
): Promise<SingOutcome> {
  let sung: Song;
  try {
    sung = await singMissing(song, api, onProgress, signal);
  } catch (err) {
    if (signal.aborted) return { kind: 'cancelled' };
    throw err;
  }
  if (signal.aborted) return { kind: 'cancelled' };
  if (!isStillCurrent(song)) return { kind: 'changed' };
  return { kind: 'play', song: sung };
}

/** The one singing run at a time (Play while singing cancels it). */
let current: AbortController | undefined;
export const singRun = {
  /** Starts a run, or cancels the running one and returns undefined. */
  toggle(): AbortController | undefined {
    if (current) {
      current.abort();
      current = undefined;
      return undefined;
    }
    current = new AbortController();
    return current;
  },
  done(run: AbortController): void {
    if (current === run) current = undefined;
  },
  active: (): boolean => current !== undefined,
};

/**
 * What the editor's views (mixer, waveforms) load: the song as it plays ('song'); the song without its vocal
 * ('instrumental') while a section is not sung for the song as it is (the brain would refuse it; the greyed vocal
 * track shows what is missing; Play sings first); or nothing yet ('wait') while that is not known.
 */
export function viewSource(song: Song, status: readonly SectionStatus[] | undefined): 'song' | 'instrumental' | 'wait' {
  if (!song.vocals?.enabled) return 'song';
  if (!status) return 'wait';
  return status.every((s) => s.state === 'none' || s.state === 'current') ? 'song' : 'instrumental';
}

/** Indexes (in `sections`) of the sections whose lead vocal is not sung (missing or stale take; a take that is
 *  sung and stored but not recorded on this copy counts as sung): the timeline greys them out. None while the
 *  status is not known. */
export function unsungSections(sections: readonly { readonly name: string }[], status: readonly SectionStatus[] | undefined): ReadonlySet<number> {
  if (!status) return new Set();
  const unsung = new Set(status.filter((s) => s.state === 'missing' || s.state === 'stale').map((s) => s.segment));
  return new Set(sections.flatMap((s, i) => (unsung.has(s.name) ? [i] : [])));
}
