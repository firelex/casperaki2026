// Vocal edits: the words of a song (written lyrics) and a new melody for a section type, recorded in the generator
// block and applied to the working song section by section, throughout the song
// (docs/superpowers/specs/2026-11-24-written-lyrics-design.md).
//
// The brain writes the words (a language model); this module is pure: it says which lines the melody has, checks
// nothing itself (see vocals/written-lyrics.ts) and splices regenerated sections into the working song.

import { parseSong, SUNG_TAKE_KINDS, vocalTakeFingerprint, Sha256Schema, type AIArtifact, type Song } from '@casperaki/song-schema';

import { segmentType } from '../arrangement-polish/segment-type.js';
import type { GenerateParams } from '../context.js';
import { userChorusOf } from '../hum/user-chorus.js';
import { createRng } from '@casperaki/music-theory';

import { orchestrate, vocalSelections } from '../orchestrate/index.js';
import { LYRIC_RHYTHMS_PARAM, lyricRhythmsOf, RHYTHM_VARIANTS_PARAM, rhythmVariantsOf } from '../vocals/lyric-rhythms.js';
import { drawRhythm, expandMergedToSegment, type MergedPrecedent } from '../vocals/precedents.js';
import { recutRhythm, type RecutRhythm } from '../vocals/recut.js';
import { ECHO_TYPES } from '../vocals/free-lyrics.js';
import { lyricLines, type LyricLine } from '../vocals/lyric-lines.js';
import { MELODY_VARIANTS_PARAM, melodyVariantsOf } from '../vocals/melody-variants.js';
import { SUNG_MELODY_PARAM, SungMelodySchema, sungMelodyOf, type SungMelody } from '../vocals/sung-melody.js';
import { VOCAL_MELODY_PARAM, vocalMelodyShownIn } from '../vocals/vocal-melody.js';
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

/** The generator params without the sung melody of the sections of these types (new words no longer fit it). */
function paramsWithoutSung(params: GenerateParams, types: ReadonlySet<string>): GenerateParams {
  const sung = sungMelodyOf(params.params);
  const kept = Object.fromEntries(Object.entries(sung).filter(([name]) => !types.has(segmentType(name))));
  if (Object.keys(kept).length === Object.keys(sung).length) return params;
  const inner = { ...(params.params ?? {}) };
  if (Object.keys(kept).length > 0) inner[SUNG_MELODY_PARAM] = kept;
  else delete inner[SUNG_MELODY_PARAM];
  return withInner(params, inner);
}

/** Whether the song's vocal tracks show their melody (see vocals/vocal-melody.ts). */
export function vocalMelodyShown(song: Song): boolean {
  return vocalMelodyShownIn(generatorParams(song).params);
}

/** The generator params with the vocal melody shown (the param dropped). */
function paramsShowingMelody(params: GenerateParams): GenerateParams {
  const inner = { ...(params.params ?? {}) };
  delete inner[VOCAL_MELODY_PARAM];
  return withInner(params, inner);
}

/** The working song with the regenerated vocal tracks in every section: each on where the generator has it on
 *  (by section name, else by a section of the same type). */
function showVocals(working: Song, regenerated: Song): Song {
  let song = working;
  for (const track of vocalTracks(regenerated)) {
    const on = (name: string): boolean => {
      const own = regenerated.arrangement[name];
      if (own) return own.instruments[track] === true;
      const same = regenerated.songStructure.find((s) => segmentType(s.name) === segmentType(name));
      return same ? regenerated.arrangement[same.name]!.instruments[track] === true : false;
    };
    song = spliceTrack(song, regenerated, track, new Set(song.songStructure.map((s) => s.name).filter(on)));
  }
  return song;
}

/** Write melody: the working song's vocal tracks show the melody the generator chose for the song (every section).
 *  An error when they show it already. */
export function writeMelody(working: Song): Song {
  if (vocalMelodyShown(working)) return rewriteMelody(working);
  const params = paramsShowingMelody(generatorParams(working));
  return recordParams(showVocals(working, orchestrate(params)), params);
}

/**
 * Write melody on a song that shows one (owner, 2026-11-27: it is always there, and the words just go): a new melody
 * in every sung type (its next melody variant that changes the lead; a hummed chorus keeps the hum), the words, their
 * recut rhythms and the sung melody dropped, so the sung takes come out stale.
 */
function rewriteMelody(working: Song): Song {
  const params = generatorParams(working);
  const inner: Record<string, unknown> = { ...(params.params ?? {}) };
  for (const key of [WRITTEN_LYRICS_PARAM, LYRIC_RHYTHMS_PARAM, RHYTHM_VARIANTS_PARAM, SUNG_MELODY_PARAM]) delete inner[key];
  let next = withInner(params, inner);
  const current = orchestrate(params);
  const types = new Set(sungSections(current).map((s) => s.type));
  for (const type of types) {
    if (type === 'chorus' && userChorusOf(params.params)) continue;
    const before = vocalSignature(current, type);
    const variants = melodyVariantsOf(next.params);
    let found = false;
    for (let v = (variants[type] ?? 0) + 1, tries = 0; tries < MELODY_TRIES; v++, tries++) {
      const tried = withInner(next, { ...(next.params ?? {}), [MELODY_VARIANTS_PARAM]: { ...variants, [type]: v } });
      if (vocalSignature(orchestrate(tried), type) === before) continue;
      next = tried;
      found = true;
      break;
    }
    if (!found) throw new TrackEditError(409, 'no_other_melody', `No other ${type} melody changes this song.`);
  }
  return applyVocalParams(working, next, types);
}

/**
 * The working song with new words for some sections (generator names): recorded in the generator block, and the
 * vocal tracks regenerated in every working section of those sections' types. Words are written for the melody, so a
 * hidden melody is shown (every section).
 */
export function applyWrittenLyrics(working: Song, lyrics: WrittenLyrics): Song {
  const types = new Set(Object.keys(lyrics).map(segmentType));
  return applyVocalParams(working, paramsWithoutSung(paramsWithLyrics(generatorParams(working), lyrics), types), types);
}

/** The working song regenerated with these params in the vocal tracks of the sections of these types (every section,
 *  showing the melody, when the song's vocal melody is hidden). */
function applyVocalParams(working: Song, next: GenerateParams, types: ReadonlySet<string>): Song {
  const hidden = !vocalMelodyShown(working);
  const params = hidden ? paramsShowingMelody(next) : next;
  const regenerated = orchestrate(params);
  if (hidden) return recordParams(showVocals(working, regenerated), params);
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
  // Lyrics first: the type keeps its words and its recut rhythm; only the melody laid on it changes (a melody of
  // another length than the recut is passed over).
  const recut = recutOfType(lyricRhythmsOf(params.params), type);
  const lyrics = Object.fromEntries(Object.entries(writtenLyricsOf(params.params)).filter(([name]) => recut !== undefined || segmentType(name) !== type));
  const before = vocalSignature(current, type);
  // A sung melody of the type would stay on the lead whatever the variant (it replaces the lead's notes), so a new
  // melody drops it, as new words do (applyWrittenLyrics); the type's sung takes then come out stale.
  const unsung = paramsWithoutSung(params, new Set([type]));
  for (let v = (variants[type] ?? 0) + 1, tries = 0; tries < MELODY_TRIES; v++, tries++) {
    const inner: Record<string, unknown> = { ...(unsung.params ?? {}), [MELODY_VARIANTS_PARAM]: { ...variants, [type]: v } };
    if (Object.keys(lyrics).length > 0) inner[WRITTEN_LYRICS_PARAM] = lyrics;
    else delete inner[WRITTEN_LYRICS_PARAM];
    const next = withInner(unsung, inner);
    if (recut) {
      const melody = vocalSelections(next).get(type);
      if (!melody || melody.properties.end - melody.properties.start !== recut.bars) continue;
    }
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

export interface SungTake {
  readonly segment: string;
  readonly track: string;
  readonly kind: (typeof SUNG_TAKE_KINDS)[number];
  readonly sha256: string;
  readonly durationSeconds: number;
  readonly modelId: string;
  readonly modelVersion: string;
  readonly seed?: number;
}

/** How much of the song a sung result covers. */
export interface ApplySungOptions {
  /** The result covers only the sections of its melody (Transcribe melody): sung takes of other sections are kept,
   *  those of its sections replaced by `sung.takes`. Without it (Sing) every earlier sung take is replaced. */
  readonly partial?: boolean;
}

/**
 * The working song with the sung melody of some sections (recorded as `sungMelody`, replacing the lead's notes and
 * words there; other sections keep their recorded sung melody; the vocal tracks regenerated and spliced as for
 * written lyrics) and the song's sung-take artifacts replaced by `sung.takes` (all of them, or with `partial` only
 * those of the melody's sections), each stamped with the fingerprint of the vocal lane it was sung over.
 */
export function applySungVocals(working: Song, sung: { melody: SungMelody; takes: readonly SungTake[] }, opts: ApplySungOptions = {}): Song {
  const melody = SungMelodySchema.parse(sung.melody);
  const hidden = !vocalMelodyShown(working);
  const base = generatorParams(working);
  const inner = { ...(base.params ?? {}), [SUNG_MELODY_PARAM]: { ...sungMelodyOf(base.params), ...melody } };
  const withMelody = withInner(base, inner);
  const params = hidden ? paramsShowingMelody(withMelody) : withMelody;
  const regenerated = orchestrate(params);
  let song = working;
  if (hidden) song = showVocals(working, regenerated);
  else {
    const names = new Set(Object.keys(melody));
    for (const track of vocalTracks(regenerated)) {
      if (!song.instrumentDefinitions.some((d) => d.name === track)) continue;
      song = spliceTrack(song, regenerated, track, undefined, (name) => names.has(name));
    }
  }
  song = recordParams(song, params);
  const replaced = (a: AIArtifact) =>
    (SUNG_TAKE_KINDS as readonly string[]).includes(a.kind) &&
    (!opts.partial || (a.attachedTo.scope === 'segment' && melody[a.attachedTo.segment] !== undefined));
  if (opts.partial) {
    for (const t of sung.takes) {
      if (melody[t.segment] === undefined) throw new Error(`applySungVocals: a partial result's take is for ${t.segment}, which is not among its sections`);
    }
  }
  const kept = song.aiArtifacts.filter((a) => !replaced(a));
  const artifacts: AIArtifact[] = sung.takes.map((t) => {
    if (!SUNG_TAKE_KINDS.includes(t.kind)) throw new Error(`applySungVocals: unknown take kind "${t.kind}"`);
    const sha256 = Sha256Schema.parse(t.sha256);
    return {
      id: `${t.kind}:${t.segment}:${t.track}:${t.sha256.slice(0, 8)}`,
      kind: t.kind,
      modelId: t.modelId,
      modelVersion: t.modelVersion,
      ...(t.seed !== undefined ? { seed: t.seed } : {}),
      conditioning: { hashes: [Sha256Schema.parse(vocalTakeFingerprint(song, t.segment, t.track))] },
      output: { uri: `vocal-take:${t.sha256}.ogg`, sha256, durationSeconds: t.durationSeconds },
      attachedTo: { scope: 'segment', segment: t.segment, instrument: t.track },
    };
  });
  return parseSong({ ...song, aiArtifacts: [...kept, ...artifacts] });
}

/**
 * A finished sing result put into a working copy that may have unsaved edits: `applySungVocals`, then the sung takes
 * are the ones of `saved` (the version the task's result was saved into), whose fingerprints say what they were sung
 * over. A section the working copy changed since (chords, tempo, vocal lanes) therefore comes out stale.
 */
export function applySungVocalsOver(working: Song, sung: { melody: SungMelody; takes: readonly SungTake[] }, saved: Song, opts: ApplySungOptions = {}): Song {
  const merged = applySungVocals(working, sung, opts);
  const isSung = (a: AIArtifact) => (SUNG_TAKE_KINDS as readonly string[]).includes(a.kind);
  return parseSong({ ...merged, aiArtifacts: [...merged.aiArtifacts.filter((a) => !isSung(a)), ...saved.aiArtifacts.filter(isSung)] });
}

// ---- lyrics first (docs/superpowers/specs/2026-11-27-lyrics-first-singing-design.md) ----------------------------

/** Lyrics written first, by part: a section type whose sections all sing the same words ("chorus"), or one section
 *  that has words of its own ("verse2": every verse tells its own part of the story, owner 2026-11-27); the lines for
 *  one pattern length of the type (one line per two bars). */
export type LyricsByType = Readonly<Record<string, readonly string[]>>;

const LINE_BARS = 2;
/** Section types whose every section has words of its own; the others sing the same words every time. */
export const OWN_WORDS_TYPES: ReadonlySet<string> = new Set(['verse']);

/** The parts the lyrics of a song are written in, in song order: a part per sung section of a type in
 *  OWN_WORDS_TYPES ("verse1", "verse2"), a part per other sung type ("chorus"); each with its section type and how many
 *  lines it needs (one per two bars of the melody chosen for the type). */
export function lyricsFirstParts(params: GenerateParams): { readonly part: string; readonly type: string; readonly lines: number }[] {
  const selections = vocalSelections(params);
  const generated = orchestrate(params);
  const out: { part: string; type: string; lines: number }[] = [];
  for (const s of generated.songStructure) {
    const type = segmentType(s.name);
    const melody = selections.get(type);
    if (!melody || !generated.arrangement[s.name]?.overrides[LEAD_VOCAL_TRACK]) continue;
    const part = OWN_WORDS_TYPES.has(type) ? s.name : type;
    if (out.some((x) => x.part === part)) continue;
    out.push({ part, type, lines: (melody.properties.end - melody.properties.start) / LINE_BARS });
  }
  return out;
}

/** For each lyric line of a section of `sectionBars` bars, the line of the `patternBars`-bar pattern it sings: the
 *  generator lays the pattern over a longer section by repeating it and copying its last bars into what is left
 *  (expandMergedToSegment), and each line takes the words of the bars it was copied from. */
function patternLineOf(patternBars: number, sectionBars: number): number[] {
  const probe = {
    properties: { start: 0, end: patternBars },
    melody: Object.fromEntries(Array.from({ length: patternBars }, (_, b) => [`${b * 4}.0`, [{ midi: b, duration: 1 }]])),
  } as unknown as MergedPrecedent;
  const sourceBar = new Map(expandMergedToSegment(probe, sectionBars).map((e) => [e.barIndex, e.midi]));
  return Array.from({ length: sectionBars / LINE_BARS }, (_, i) => {
    const bar = sourceBar.get(i * LINE_BARS);
    if (bar === undefined) throw new TrackEditError(400, 'section_length', `A section of ${sectionBars} bars cannot sing a ${patternBars}-bar melody line by line.`);
    return Math.floor(bar / LINE_BARS);
  });
}

/** The sung sections of `generated` the part's words go to: the section itself, or every section of the type. */
function sectionsOfPart(generated: Song, part: string): Song['songStructure'] {
  return generated.songStructure.filter((s) => (s.name === part || segmentType(s.name) === part) && generated.arrangement[s.name]?.overrides[LEAD_VOCAL_TRACK]);
}

/** The part's lines for each of its sections (a longer section sings them as its bars repeat the pattern), by
 *  section name. */
function linesBySection(generated: Song, part: string, lines: readonly string[]): WrittenLyrics {
  const patternBars = lines.length * LINE_BARS;
  return Object.fromEntries(sectionsOfPart(generated, part).map((s) => [s.name, patternLineOf(patternBars, s.bars.length).map((k) => lines[k]!)]));
}

/** The stored recut parts of a type: the type itself, or its sections with words of their own. */
function partsOfType(recuts: Readonly<Record<string, RecutRhythm>>, type: string): string[] {
  return Object.keys(recuts).filter((part) => part === type || (part !== segmentType(part) && segmentType(part) === type));
}

/** The type's recut rhythm, whichever of its parts holds it (all its parts are cut from one pattern to the same
 *  length). */
export function recutOfType(recuts: Readonly<Record<string, RecutRhythm>>, type: string): RecutRhythm | undefined {
  const part = partsOfType(recuts, type)[0];
  return part === undefined ? undefined : recuts[part];
}

/** The params with the recuts of `types` replaced by `recuts` (a type's parts all go: words per type or per section,
 *  never both). */
function withRhythms(params: GenerateParams, types: ReadonlySet<string>, recuts: Readonly<Record<string, RecutRhythm>>, variants?: Readonly<Record<string, number>>): GenerateParams {
  const kept = Object.fromEntries(Object.entries(lyricRhythmsOf(params.params)).filter(([part]) => !types.has(segmentType(part))));
  const inner: Record<string, unknown> = { ...(params.params ?? {}), [LYRIC_RHYTHMS_PARAM]: { ...kept, ...recuts } };
  if (variants) inner[RHYTHM_VARIANTS_PARAM] = { ...rhythmVariantsOf(params.params), ...variants };
  return withInner(params, inner);
}

/**
 * Lyrics first: per type, the current rhythm (the pattern its stored recut came from, else the rhythm of the melody
 * the generator chose; a hummed chorus: the hum) recut to each part's lines; the recuts and the words recorded (a
 * longer section repeats the lines), the type's sung melody dropped, the vocal tracks of those sections regenerated.
 * A part is a type or one of its sections (lyricsFirstParts); a type's words come all per type or all per section.
 */
export function applyLyricsFirst(working: Song, lyrics: LyricsByType): Song {
  const base = generatorParams(working);
  const shown = vocalMelodyShown(working) ? base : paramsShowingMelody(base);
  const selections = vocalSelections(shown);
  const generated = orchestrate(shown);
  const stored = lyricRhythmsOf(shown.params);
  const byType = new Map<string, string[]>();
  for (const part of Object.keys(lyrics)) {
    const type = segmentType(part);
    if (sectionsOfPart(generated, part).length === 0) throw new TrackEditError(400, 'not_sung', `The song has no sung ${part} section.`);
    byType.set(type, [...(byType.get(type) ?? []), part]);
  }
  const recuts: Record<string, RecutRhythm> = {};
  let written: WrittenLyrics = {};
  for (const [type, parts] of byType) {
    const melody = selections.get(type);
    if (!melody) throw new TrackEditError(400, 'not_sung', `The song has no sung ${type} section.`);
    if (parts.includes(type) && parts.length > 1) throw new TrackEditError(400, 'mixed_parts', `Words for the ${type} come for every ${type} or for each one, not both.`);
    if (!parts.includes(type)) {
      const missing = sectionsOfPart(generated, type).map((s) => s.name).filter((name) => !parts.includes(name));
      if (missing.length > 0) throw new TrackEditError(400, 'missing_part', `Words for ${missing.join(', ')} are missing: every ${type} needs its own.`);
    }
    const bars = melody.properties.end - melody.properties.start;
    const source = recutOfType(stored, type)?.source ?? melody.rhythmic;
    for (const part of parts) {
      const lines = lyrics[part]!;
      if (lines.length * LINE_BARS !== bars) throw new TrackEditError(400, 'line_count', `The ${part} needs ${bars / LINE_BARS} lines (one per ${LINE_BARS} bars), not ${lines.length}.`);
      recuts[part] = recutRhythm(source, lines, { bpm: shown.bpm, bars, echo: ECHO_TYPES.has(type) });
      written = { ...written, ...linesBySection(generated, part, lines) };
    }
  }
  const types = new Set(byType.keys());
  return applyVocalParams(working, paramsWithoutSung(withRhythms(paramsWithLyrics(base, written), types, recuts), types), types);
}

/**
 * New rhythm: another random rhythm (the type's next rhythm variant, its own stream) recut to the words of each of
 * the type's parts, the first that changes the lead; words, melody and chords kept, the type's sung melody dropped.
 * Only for a type with lyrics-first words.
 */
export function newRhythm(working: Song, type: string): Song {
  const params = generatorParams(working);
  const stored = lyricRhythmsOf(params.params);
  const parts = partsOfType(stored, type);
  if (parts.length === 0) throw new TrackEditError(409, 'no_lyrics', 'Write lyrics first: a new rhythm is bent to the words.');
  const current = orchestrate(params);
  const written = writtenLyricsOf(params.params);
  const linesOf = (part: string): string[] => {
    const first = sectionsOfPart(current, part)[0];
    const words = first ? written[first.name] : undefined;
    if (!first || !words) throw new TrackEditError(409, 'no_lyrics', 'Write lyrics first: a new rhythm is bent to the words.');
    return words.slice(0, stored[part]!.bars / LINE_BARS);
  };
  const lines = Object.fromEntries(parts.map((part) => [part, linesOf(part)]));
  const bars = stored[parts[0]!]!.bars;
  const before = vocalSignature(current, type);
  const variants = rhythmVariantsOf(params.params);
  for (let v = (variants[type] ?? 0) + 1, tries = 0; tries < MELODY_TRIES; v++, tries++) {
    const rhythm = drawRhythm({ desiredPatternLength: bars, segmentType: type, genre: params.genre, tempo: params.bpm, rng: createRng(`${params.seed}/vocals/rhythm/${type}#v${v}`) });
    const recuts = Object.fromEntries(parts.map((part) => [part, recutRhythm(rhythm, lines[part]!, { bpm: params.bpm, bars, echo: ECHO_TYPES.has(type) })]));
    const next = paramsWithoutSung(withRhythms(params, new Set([type]), recuts, { [type]: v }), new Set([type]));
    if (vocalSignature(orchestrate(next), type) === before) continue;
    return applyVocalParams(working, next, new Set([type]));
  }
  throw new TrackEditError(409, 'no_other_rhythm', `No other ${type} rhythm changes this song.`);
}
