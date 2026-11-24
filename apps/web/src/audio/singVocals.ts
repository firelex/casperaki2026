// Sung vocals (docs/superpowers/specs/2026-11-24-sung-vocals-design.md, revised 2026-11-24): the brain keeps a take
// per section, found by fingerprint whenever the song is loaded (nothing is written into the song). A section with
// a take plays it; one without is "unsung" (greyed). The song's vocals setting holds the voice, the take numbers
// ("Sing again") and `enabled`: whether Play first sings the unsung sections.

import type { Song } from '@casperaki/song-schema';

import type { SectionStatus } from '../api/vocals';

export const LEAD_VOCAL = 'Vocal';
export type VocalsSetting = NonNullable<Song['vocals']>;

/** A vocal track's singing setting: the lead's is `vocals`, a backing track's `backingVocals[track]`. */
export function trackSetting(song: Song, track: string): VocalsSetting | undefined {
  return track === LEAD_VOCAL ? song.vocals : song.backingVocals?.[track];
}

function withSetting(song: Song, track: string, setting: VocalsSetting): Song {
  return track === LEAD_VOCAL ? { ...song, vocals: setting } : { ...song, backingVocals: { ...song.backingVocals, [track]: setting } };
}

/** Singing on (Play sings the track's grey sections) or off, with a voice; take numbers are kept. */
export function withVocals(song: Song, track: string, enabled: boolean, voice?: string): Song {
  const cur = trackSetting(song, track);
  const v = voice ?? cur?.voice;
  if (!v) throw new Error(`withVocals: singing ${track} needs a voice`);
  return withSetting(song, track, { enabled, voice: v, takeNumbers: cur?.takeNumbers ?? {} });
}

/** Another voice for the track (its takes are other takes: sections it has not sung are unsung). */
export function withVoice(song: Song, track: string, voice: string): Song {
  const cur = trackSetting(song, track);
  if (!cur) throw new Error(`withVoice: ${track} has no singing setting`);
  return withSetting(song, track, { ...cur, voice });
}

/** A fresh take of these sections of the track: their take numbers go up by one (unsung until sung). */
export function singAgain(song: Song, track: string, segments: string | readonly string[]): Song {
  const cur = trackSetting(song, track);
  if (!cur) throw new Error(`singAgain: ${track} has no singing setting`);
  const takeNumbers = { ...cur.takeNumbers };
  for (const s of typeof segments === 'string' ? [segments] : segments) takeNumbers[s] = (takeNumbers[s] ?? 1) + 1;
  return withSetting(song, track, { ...cur, takeNumbers });
}

/** The vocal tracks whose singing is on (Play sings their grey sections), the lead first. */
export function singingTracks(song: Song): string[] {
  return [...(song.vocals?.enabled ? [LEAD_VOCAL] : []), ...Object.entries(song.backingVocals ?? {}).filter(([, v]) => v.enabled).map(([t]) => t)];
}

/** Whether the song has any vocal track with a singing setting (its takes are looked up). */
export const hasVocalSettings = (song: Song | undefined): boolean => Boolean(song?.vocals || Object.keys(song?.backingVocals ?? {}).length);

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

/** A short token of which sections have takes on which tracks: part of the player's key, so a song plays again
 *  with the takes sung since it was loaded. */
export function takesToken(tracks: Readonly<Record<string, readonly SectionStatus[]>>): string {
  return Object.keys(tracks)
    .sort()
    .map((t) => `${t}:${tracks[t]!.filter((s) => s.state === 'sung').map((s) => s.segment).join(',')}`)
    .join(';');
}

/** The (track, section) pairs to sing while playing from `positionSec`: the singing tracks' unsung sections in
 *  singOrder, the lead before the backing tracks within a section. */
export function singQueue(song: Song, tracks: Readonly<Record<string, readonly SectionStatus[]>>, positionSec: number): { track: string; segment: string }[] {
  const on = singingTracks(song);
  const unsung = new Set(on.flatMap((t) => (tracks[t] ?? []).filter((s) => s.state === 'unsung').map((s) => s.segment)));
  return singOrder([...unsung], sectionStarts(song), positionSec).flatMap((segment) =>
    on.filter((t) => (tracks[t] ?? []).some((s) => s.segment === segment && s.state === 'unsung')).map((track) => ({ track, segment })),
  );
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

/** Indexes (in `sections`) of a vocal track's grey boxes: every section while its singing is off (it is silent)
 *  or the status is not known yet; with singing on, the sections not sung yet. */
export function greySections(sections: readonly { readonly name: string }[], setting: VocalsSetting | undefined, status: readonly SectionStatus[] | undefined): ReadonlySet<number> {
  if (!setting?.enabled || !status) return new Set(sections.map((_, i) => i));
  return unsungSections(sections, status);
}

/** Whether swapping the playing song for the version with these newly sung sections is worth it now: only when
 *  one of them starts ahead of the playhead (it will be heard this time through). Each swap rebuilds the engine on
 *  the audio thread, which can crackle, so sections already passed wait for the next play. */
export function worthSwapping(newlySung: readonly string[], starts: readonly { segment: string; start: number }[], positionSec: number): boolean {
  return starts.some((s) => newlySung.includes(s.segment) && s.start > positionSec);
}
