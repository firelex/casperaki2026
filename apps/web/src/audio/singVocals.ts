// Sung vocals (docs/superpowers/specs/2026-11-24-sung-vocals-design.md, revised 2026-11-24): the brain keeps a take
// per section, found by fingerprint whenever the song is loaded (nothing is written into the song). A section with
// a take plays it; one without is "unsung" (greyed). The song's vocals setting holds the voice, the take numbers
// ("Sing again") and `enabled`: whether Play first sings the unsung sections.

import type { Song } from '@casperaki/song-schema';

import type { SectionStatus } from '../api/vocals';

/** Vocals on (Play sings unsung sections) or off, with a voice; take numbers are kept. */
export function withVocals(song: Song, enabled: boolean, voice?: string): Song {
  const v = voice ?? song.vocals?.voice;
  if (!v) throw new Error('withVocals: the vocals setting needs a voice');
  return { ...song, vocals: { enabled, voice: v, takeNumbers: song.vocals?.takeNumbers ?? {} } };
}

/** Another voice (its takes are other takes: sections it has not sung are unsung). */
export function withVoice(song: Song, voice: string): Song {
  if (!song.vocals) throw new Error('withVoice: the song has no vocals setting');
  return { ...song, vocals: { ...song.vocals, voice } };
}

/** A fresh take of these sections: their take numbers go up by one (they are unsung until sung). */
export function singAgain(song: Song, segments: string | readonly string[]): Song {
  if (!song.vocals) throw new Error('singAgain: the song has no vocals setting');
  const takeNumbers = { ...song.vocals.takeNumbers };
  for (const s of typeof segments === 'string' ? [segments] : segments) takeNumbers[s] = (takeNumbers[s] ?? 1) + 1;
  return { ...song, vocals: { ...song.vocals, takeNumbers } };
}

export interface SingApi {
  status(song: Song, signal?: AbortSignal): Promise<{ sections: SectionStatus[] }>;
  sing(song: Song, segment: string, signal?: AbortSignal): Promise<{ section: SectionStatus }>;
}

/** Sings every unsung section, one after another ("Singing chorus1 (2 of 3)"); returns how many were sung.
 *  A failure throws (the caller shows it). */
export async function singMissing(song: Song, api: SingApi, onProgress: (text: string) => void, signal?: AbortSignal): Promise<number> {
  const todo = (await api.status(song, signal)).sections.filter((s) => s.state === 'unsung').map((s) => s.segment);
  for (const [i, segment] of todo.entries()) {
    onProgress(`Singing ${segment} (${i + 1} of ${todo.length})`);
    await api.sing(song, segment, signal);
  }
  return todo.length;
}

/** The one singing run at a time: a new one (Play again) cancels the one running; the Vocals panel can stop it. */
let current: AbortController | undefined;
export const singRun = {
  start(): AbortController {
    current?.abort();
    current = new AbortController();
    return current;
  },
  cancel(): void {
    current?.abort();
    current = undefined;
  },
  done(run: AbortController): void {
    if (current === run) current = undefined;
  },
  active: (): boolean => current !== undefined,
};

/** Where each section starts, in seconds (4/4). */
export function sectionStarts(song: Song): { segment: string; start: number }[] {
  const secPerBar = (4 * 60) / song.bpm;
  let bar = 0;
  return song.songStructure.map((seg) => {
    const start = bar * secPerBar;
    bar += seg.lengthInBars ?? seg.bars.length;
    return { segment: seg.name, start };
  });
}

/** Indexes (in `sections`) of the unsung sections (no take for them as they are): the timeline greys them out.
 *  None while the status is not known. */
export function unsungSections(sections: readonly { readonly name: string }[], status: readonly SectionStatus[] | undefined): ReadonlySet<number> {
  if (!status) return new Set();
  const unsung = new Set(status.filter((s) => s.state === 'unsung').map((s) => s.segment));
  return new Set(sections.flatMap((s, i) => (unsung.has(s.name) ? [i] : [])));
}

/** A short token of which sections have takes: part of the player's key, so a song plays again with the takes
 *  sung since it was loaded. */
export function takesToken(status: readonly SectionStatus[]): string {
  return status.filter((s) => s.state === 'sung').map((s) => s.segment).join(',');
}

/** The order to sing unsung sections while the song plays from `positionSec`: the section being played (or the
 *  next one), then on through the song, then the sections already passed. */
export function singOrder(unsung: readonly string[], starts: readonly { segment: string; start: number }[], positionSec: number): string[] {
  const indexOf = new Map(starts.map((s, i) => [s.segment, i]));
  let here = 0;
  starts.forEach((s, i) => {
    if (s.start <= positionSec + 1e-6) here = i;
  });
  return [...unsung].sort((a, b) => {
    const ia = indexOf.get(a)!;
    const ib = indexOf.get(b)!;
    const ra = ia >= here ? ia - here : ia + starts.length;
    const rb = ib >= here ? ib - here : ib + starts.length;
    return ra - rb;
  });
}
