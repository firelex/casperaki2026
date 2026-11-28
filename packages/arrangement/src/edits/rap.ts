// Rap like singing (docs/superpowers/specs/2026-11-28-rap-like-singing-design.md): the rap's words per section, kept
// in the generator settings beside the sung words (`rapLyrics`); which sections have rap; sung takes muted where
// there is rap (lead and backing), and any take muted or unmuted by hand.

import {
  ACE_LAYER_KIND,
  aceInstrumentOfTrack,
  parseSong,
  SUNG_TAKE_KINDS,
  type AIArtifact,
  type Song,
} from '@casperaki/song-schema';
import { z } from 'zod';

import { generatorParams } from './track-edits.js';

export const RAP_LYRICS_PARAM = 'rapLyrics';

const RapLyricsSchema = z.record(z.string(), z.array(z.string()));

/** The rap's words per section (section name → lines); empty when none were written. */
export function rapLyricsOf(song: Song): Record<string, string[]> {
  const inner = (song.generator?.params as { params?: Record<string, unknown> } | undefined)?.params;
  const raw = inner?.[RAP_LYRICS_PARAM];
  if (raw === undefined) return {};
  const parsed = RapLyricsSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`the song's ${RAP_LYRICS_PARAM} are not section → lines: ${parsed.error.message}`);
  return parsed.data;
}

/** The song with these sections' rap words (other sections keep theirs). */
export function applyRapLyrics(song: Song, lyrics: Readonly<Record<string, readonly string[]>>): Song {
  const out: Record<string, string[]> = { ...rapLyricsOf(song) };
  for (const [section, lines] of Object.entries(lyrics)) {
    if (!song.songStructure.some((s) => s.name === section)) throw new Error(`applyRapLyrics: the song has no section "${section}"`);
    const kept = lines.map((l) => l.trim()).filter((l) => l.length > 0);
    if (kept.length === 0) throw new Error(`applyRapLyrics: ${section} has no lines`);
    out[section] = kept;
  }
  const block = generatorParams(song) as { params?: Record<string, unknown> };
  return parseSong({
    ...song,
    generator: {
      ...song.generator,
      params: { ...(song.generator!.params as Record<string, unknown>), params: { ...(block.params ?? {}), [RAP_LYRICS_PARAM]: out } },
    },
  });
}

const isRapClip = (a: AIArtifact) => a.kind === ACE_LAYER_KIND && a.attachedTo.scope === 'segment' && aceInstrumentOfTrack(a.attachedTo.instrument ?? '') === 'rap';
const isSungTake = (a: AIArtifact) => (SUNG_TAKE_KINDS as readonly string[]).includes(a.kind) && a.attachedTo.scope === 'segment';
const segmentOf = (a: AIArtifact) => (a.attachedTo.scope === 'segment' ? a.attachedTo.segment : undefined);

/** The sections with a rap clip, in song order. */
export function rapSections(song: Song): string[] {
  const rapped = new Set(song.aiArtifacts.filter(isRapClip).map(segmentOf));
  return song.songStructure.map((s) => s.name).filter((n) => rapped.has(n));
}

/** The song with the sung takes (every track) muted in those of `sections` that have rap. */
export function muteUnderRap(song: Song, sections: readonly string[]): Song {
  const rapped = new Set(rapSections(song).filter((s) => sections.includes(s)));
  if (rapped.size === 0) return song;
  return parseSong({ ...song, aiArtifacts: song.aiArtifacts.map((a) => (isSungTake(a) && rapped.has(segmentOf(a)!) ? { ...a, muted: true } : a)) });
}

/** The song with every take of `track` in `segment` muted or unmuted (unmuted: no `muted` field). */
export function setTakesMuted(song: Song, track: string, segment: string, muted: boolean): Song {
  const hit = (a: AIArtifact) => a.attachedTo.scope === 'segment' && a.attachedTo.segment === segment && a.attachedTo.instrument === track;
  if (!song.aiArtifacts.some(hit)) throw new Error(`setTakesMuted: ${track} has no take in ${segment}`);
  return parseSong({
    ...song,
    aiArtifacts: song.aiArtifacts.map((a) => {
      if (!hit(a)) return a;
      const { muted: _old, ...rest } = a;
      return muted ? { ...rest, muted: true } : rest;
    }),
  });
}
