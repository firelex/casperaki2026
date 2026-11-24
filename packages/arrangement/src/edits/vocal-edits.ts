// Vocal edits: the words of a song (written lyrics) and a new melody for a section type, recorded in the generator
// block and applied to the working song section by section, throughout the song
// (docs/superpowers/specs/2026-11-24-written-lyrics-design.md).
//
// The brain writes the words (a language model); this module is pure: it says which lines the melody has, checks
// nothing itself (see vocals/written-lyrics.ts) and splices regenerated sections into the working song.

import { parseSong, type Song } from '@casperaki/song-schema';

import { segmentType } from '../arrangement-polish/segment-type.js';
import type { GenerateParams } from '../context.js';
import { userChorusOf } from '../hum/user-chorus.js';
import { orchestrate } from '../orchestrate/index.js';
import { lyricLines, type LyricLine } from '../vocals/lyric-lines.js';
import { MELODY_VARIANTS_PARAM, melodyVariantsOf } from '../vocals/melody-variants.js';
import { WRITTEN_LYRICS_PARAM, writtenLyricsOf, type WrittenLyrics } from '../vocals/written-lyrics.js';
import { generatorParams, spliceTrack, TrackEditError } from './track-edits.js';

export const LEAD_VOCAL_TRACK = 'Vocal';
/** Tries for a melody that differs from the current one before giving up. */
const MELODY_TRIES = 12;

export interface SungSection {
  /** Section name (generator name). */
  readonly name: string;
  /** Section type ("verse", "chorus", …). */
  readonly type: string;
  readonly lines: readonly LyricLine[];
  /** The words sung now, one string per line. */
  readonly words: readonly string[];
}

/** The song's sung sections in order, with their lyric lines and current words. */
export function sungSections(song: Song): SungSection[] {
  const out: SungSection[] = [];
  for (const seg of song.songStructure) {
    const bars = song.arrangement[seg.name]?.overrides?.[LEAD_VOCAL_TRACK]?.bars ?? [];
    const lines = lyricLines(bars);
    if (lines.length === 0) continue;
    const syllable = (barIndex: number, beat: number): string => {
      for (const [key, evs] of Object.entries(bars[barIndex]?.notes ?? {})) {
        if (Math.abs(Number.parseFloat(key) - beat) > 1e-6) continue;
        const ev = (evs ?? []).find((e) => (e as { type?: string }).type === 'vocalNote') as { fullWord?: string } | undefined;
        if (ev?.fullWord) return ev.fullWord;
      }
      return '';
    };
    const words = lines.map((line) =>
      line
        .map((s) => syllable(s.barIndex, s.beat))
        .join(' ')
        .replace(/- /gu, '')
        .trim(),
    );
    out.push({ name: seg.name, type: segmentType(seg.name), lines, words });
  }
  return out;
}

/** The song's vocal tracks (the lead and its backings). */
function vocalTracks(song: Song): string[] {
  return song.instrumentDefinitions.filter((d) => d.instrumentGroup === 'Vocal').map((d) => d.name);
}

function withInner(params: GenerateParams, inner: Record<string, unknown>): GenerateParams {
  const { params: _old, ...rest } = params;
  return Object.keys(inner).length > 0 ? { ...rest, params: inner } : rest;
}

function recordParams(song: Song, params: GenerateParams): Song {
  return parseSong({
    ...song,
    generator: {
      ...song.generator,
      params: { ...(song.generator!.params as Record<string, unknown>), params: params.params ?? {} },
    },
  });
}

/** The generator params with these written lyrics recorded (added to, or replacing, the recorded ones). */
export function paramsWithLyrics(params: GenerateParams, lyrics: WrittenLyrics): GenerateParams {
  const inner = { ...(params.params ?? {}) };
  inner[WRITTEN_LYRICS_PARAM] = { ...writtenLyricsOf(params.params), ...lyrics };
  return withInner(params, inner);
}

/**
 * The working song with new words for some sections (generator names): recorded in the generator block, and the
 * vocal tracks regenerated in every working section of those sections' types.
 */
export function applyWrittenLyrics(working: Song, lyrics: WrittenLyrics): Song {
  const params = paramsWithLyrics(generatorParams(working), lyrics);
  const regenerated = orchestrate(params);
  const types = new Set(Object.keys(lyrics).map(segmentType));
  let song = working;
  for (const track of vocalTracks(regenerated)) {
    if (!song.instrumentDefinitions.some((d) => d.name === track)) continue;
    song = spliceTrack(song, regenerated, track, undefined, (name) => types.has(segmentType(name)));
  }
  return recordParams(song, params);
}

const vocalSignature = (song: Song, type: string): string =>
  JSON.stringify(
    song.songStructure
      .filter((s) => segmentType(s.name) === type)
      .map((s) => song.arrangement[s.name]?.overrides?.[LEAD_VOCAL_TRACK]?.bars?.map((b) => b.notes) ?? []),
  );

export interface NewMelody {
  /** The working song with every section of the type regenerated (all tracks, chords); its words there are the
   *  phrase bank's until written lyrics are applied. */
  readonly song: Song;
  /** The song as the generator now makes it, for writing the new sections' words. */
  readonly generated: Song;
  /** The generator's sections of the type (their words are to be written). */
  readonly sections: readonly string[];
}

/**
 * A new melody for every section of a type: recorded as the type's next melody variant (the first that differs from
 * the current melody), the type's recorded words dropped, and every track and the chords of those sections spliced
 * into the working song.
 */
export function newMelody(working: Song, type: string): NewMelody {
  const params = generatorParams(working);
  if (type === 'chorus' && userChorusOf(params.params)) {
    throw new TrackEditError(409, 'hummed_chorus', 'This chorus is the melody you hummed, so it keeps it.');
  }
  const current = orchestrate(params);
  if (!sungSections(current).some((s) => s.type === type)) {
    throw new TrackEditError(400, 'not_sung', `The song has no sung ${type} section.`);
  }
  const variants = melodyVariantsOf(params.params);
  const lyrics = Object.fromEntries(Object.entries(writtenLyricsOf(params.params)).filter(([name]) => segmentType(name) !== type));
  const before = vocalSignature(current, type);
  for (let v = (variants[type] ?? 0) + 1, tries = 0; tries < MELODY_TRIES; v++, tries++) {
    const inner: Record<string, unknown> = { ...(params.params ?? {}), [MELODY_VARIANTS_PARAM]: { ...variants, [type]: v } };
    if (Object.keys(lyrics).length > 0) inner[WRITTEN_LYRICS_PARAM] = lyrics;
    else delete inner[WRITTEN_LYRICS_PARAM];
    const next = withInner(params, inner);
    const generated = orchestrate(next);
    if (vocalSignature(generated, type) === before) continue;
    return { song: recordParams(spliceSectionsOfType(working, generated, type), next), generated, sections: sungSections(generated).filter((s) => s.type === type).map((s) => s.name) };
  }
  throw new TrackEditError(409, 'no_other_melody', `No other ${type} melody fits this song.`);
}

/** Every track of the working song, and the chords, in the sections of `type`, taken from `generated`. */
function spliceSectionsOfType(working: Song, generated: Song, type: string): Song {
  const only = (name: string) => segmentType(name) === type;
  let song = working;
  for (const def of working.instrumentDefinitions) {
    if (!generated.instrumentDefinitions.some((d) => d.name === def.name)) continue;
    song = spliceTrack(song, generated, def.name, undefined, only);
  }
  const genOfType = generated.songStructure.filter((s) => only(s.name));
  const songStructure = song.songStructure.map((seg) => {
    if (!only(seg.name)) return seg;
    const src = genOfType.find((g) => g.name === seg.name) ?? genOfType[0];
    if (!src) throw new Error(`newMelody: the regenerated song has no ${type} section`);
    return { ...seg, bars: seg.bars.map((bar, i) => ({ ...bar, chords: [...src.bars[i % src.bars.length]!.chords] })) };
  });
  return { ...song, songStructure };
}

/** For new words in every section of the type of working section `section`: the song as the generator makes it and
 *  its sections of that type (generator names). */
export function lyricsTargets(working: Song, section: string): { generated: Song; sections: string[] } {
  if (!working.songStructure.some((s) => s.name === section)) throw new TrackEditError(400, 'unknown_section', `The song has no section "${section}".`);
  const type = segmentType(section);
  const generated = orchestrate(generatorParams(working));
  const sections = sungSections(generated)
    .filter((s) => s.type === type)
    .map((s) => s.name);
  if (sections.length === 0) throw new TrackEditError(400, 'not_sung', `The song has no sung ${type} section.`);
  return { generated, sections };
}
