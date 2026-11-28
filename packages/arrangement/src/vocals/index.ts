// The vocal melody: the precedent dispatcher's notes, marked at their phrase ends (`buildVocalScaffolding`, the legacy
// `Lyricist._extractMelodyFromSong` walk: endOfPhrase on the last note of every bar). Until lyrics are written the
// notes carry no words (owner 2026-11-28: "just leave out the lyrics until we've written them"; the phrase bank's
// stand-in lines, two per section type, were looped over the busier melodies and broken mid-word). Written lyrics,
// lyrics written first and a sung melody put words on their sections.
//
// Determinism: ONE rng fork (`ctx.rng.fork('vocals')`), used by the precedent dispatcher only.

import { ChordSymbolSchema, type SongStructure } from '@casperaki/song-schema';
import { parseChord } from '@casperaki/music-theory';

import type { GeneratorContext } from '../context.js';
import {
  BACKING_OFFSET_1,
  BACKING_OFFSET_2,
  generateBackings,
} from './backing.js';
import { userChorusOf, userChorusPrecedent } from '../hum/user-chorus.js';
import { drapeOnRhythm, expandMergedToSegment, selectMergedPrecedent, type MergedPrecedent } from './precedents.js';
import { lyricRhythmsOf } from './lyric-rhythms.js';
import { recutAsPrecedent } from './recut.js';
import { buildVocalScaffolding } from './scaffolding.js';
import { buildContour } from './contour.js';
import { LEGACY_INDEX_TO_MIDI, MAX_NOTE, MIN_NOTE } from './range.js';
import { fitRange, keyOffsetFromC, mergedChordBars, refitNonChorus, sectionTransposition, transposeChordSymbol } from './fit.js';
import { markPhraseEnds } from './syllabify.js';
import { attachSungMelody, sungMelodyOf } from './sung-melody.js';
import { attachWrittenLyrics, writtenLyricsOf } from './written-lyrics.js';
import { melodyVariantsOf } from './melody-variants.js';
import type { VocalBar, VocalResult, VocalSegment } from './types.js';
import { formatBarBeat } from '@casperaki/music-theory';
import { BarBeatSchema, MidiNoteSchema, type Segment, type VocalNoteEvent } from '@casperaki/song-schema';

const SUPPORTED_GENRES = new Set([
  'ballad',
  'brightPop',
  'edm',
  'latin',
  'organicVibes',
  'rock',
  'schlager',
  'urban',
]);

const PHRASE_SEGMENT_PREFIXES = ['chorus', 'preChorus', 'bridge', 'verse'] as const;
function isSungSegment(name: string): boolean {
  return PHRASE_SEGMENT_PREFIXES.some((p) => name.startsWith(p));
}

function baseType(name: string): string {
  const m = /^[A-Za-z]+/u.exec(name);
  return m ? m[0]! : name;
}

/** The vocals only (see `writeVocals`, which also returns the sung sections' new chords). */
export function generateVocalMelody(ctx: GeneratorContext, structure: SongStructure): VocalResult {
  return writeVocals(ctx, structure).vocals;
}

/**
 * The vocal melody, lyrics and backings, and the song structure with every
 * sung section's chords replaced by the chords of the melody it borrows, all
 * in the song's key (see fit.ts). The rest of the song is written over these.
 */
export function writeVocals(
  ctx: GeneratorContext,
  structure: SongStructure,
): { vocals: VocalResult; structure: SongStructure } {
  const rng = ctx.rng.fork('vocals');
  const keyOffset = keyOffsetFromC(ctx.params.key);

  if (!SUPPORTED_GENRES.has(ctx.params.genre)) {
    throw new Error(
      `generateVocalMelody: unsupported genre "${ctx.params.genre}" — supported: ${[...SUPPORTED_GENRES].join(', ')}`,
    );
  }

  // Phase 1 — vocal melody from precedents (Step 17b, unchanged).
  const selected = sectionMelodies(ctx, structure, rng);
  const lyricRhythms = lyricRhythmsOf(ctx.params.params);
  const skeleton: VocalSegment[] = [];
  const sung = new Map<string, { merged: MergedPrecedent; type: string }>();
  const laidOn = new Map<string, MergedPrecedent>();
  for (const segment of structure) {
    if (!isSungSegment(segment.name)) continue;
    const segmentType = baseType(segment.name);
    let merged = selected.get(segmentType);
    if (!merged) continue;
    // Lyrics first: the type's melody laid on the rhythm its words bent (lyric-rhythms.ts); the draws are unchanged,
    // so nothing else moves.
    // A section with words of its own ("verse2") has its own recut; the others share their type's.
    const part = segment.name in lyricRhythms ? segment.name : segmentType;
    const recut = lyricRhythms[part];
    if (recut) {
      if (!laidOn.has(part)) laidOn.set(part, drapeOnRhythm(recutAsPrecedent(recut), merged.melodic, merged.properties.maxNote));
      merged = laidOn.get(part)!;
    }
    sung.set(segment.name, { merged, type: segmentType });
  }


  // Sung sections take the borrowed melody's chords, moved into the key.
  const sungStructure: SongStructure = structure.map((segment) => {
    const s = sung.get(segment.name);
    if (!s) return segment;
    const chordBars = mergedChordBars(s.merged, segment.bars.length);
    return {
      ...segment,
      bars: segment.bars.map((bar, i) => ({ ...bar, chords: chordBars[i]!.map((c) => transposeChordSymbol(c, keyOffset)) })),
    };
  });
  for (const segment of sungStructure) {
    const s = sung.get(segment.name);
    if (s) skeleton.push(buildSegmentSkeleton(segment, s.merged, s.type, keyOffset));
  }

  // Phase 2 — the phrase ends (lyric scaffolding); no words until lyrics are written (owner 2026-11-28).
  const skeletonResult: VocalResult = { segments: skeleton };
  const bankResult = markPhraseEnds(skeletonResult, buildVocalScaffolding(skeletonResult));
  // Written lyrics (generator params `lyrics`, see written-lyrics.ts) replace the phrase bank's words in their
  // sections.
  const written = writtenLyricsOf(ctx.params.params);
  for (const name of Object.keys(written)) {
    if (!bankResult.segments.some((s) => s.segmentName === name)) throw new Error(`written lyrics: the song has no sung section "${name}"`);
  }
  // The sung melody (generator params `sungMelody`, see sung-melody.ts) replaces the lead's notes and words in its
  // sections; the chords stay the precedent's.
  const sungMelody = sungMelodyOf(ctx.params.params);
  for (const name of Object.keys(sungMelody)) {
    if (!bankResult.segments.some((s) => s.segmentName === name)) throw new Error(`sung melody: the song has no sung section "${name}"`);
  }
  const leadResult: VocalResult = {
    segments: bankResult.segments.map((s) =>
      sungMelody[s.segmentName]
        ? attachSungMelody(s, sungMelody[s.segmentName]!)
        : written[s.segmentName]
          ? attachWrittenLyrics(s, written[s.segmentName]!, s.segmentName in lyricRhythms || baseType(s.segmentName) in lyricRhythms)
          : s,
    ),
  };

  // Phase 3 — deterministic backing vocal generator (Step 17d).
  // Two lanes: -4 (Backing vocals 1) and +4 (Backing vocals 2). The
  // generator is pure over the lead + chord stream and consumes no rng
  // draws (legacy: MelodyClass._getBackingVocals is fully deterministic
  // given the lead).
  const backings = generateBackings(leadResult, sungStructure, { pitchOffset: BACKING_OFFSET_1 });
  const backings2 = generateBackings(leadResult, sungStructure, { pitchOffset: BACKING_OFFSET_2 });

  return {
    vocals: {
      ...leadResult,
      ...(backings.length > 0 && { backings }),
      ...(backings2.length > 0 && { backings2 }),
    },
    structure: sungStructure,
  };
}

/** Builds a segment with note pitches+durations from a merged precedent but
 *  no lyric metadata yet. The lyric attach pass fills `fullWord` +
 *  `vocaloidPhonemes` + `endOfPhrase` from the syllable bank. */
function buildSegmentSkeleton(segment: Segment, merged: MergedPrecedent, kind: string, keyOffset: number): VocalSegment {
  // Sanity check chord stream (kept from 17b; surfaces missing brain chords
  // as a typed error rather than a vocal-side crash).
  for (let i = 0; i < segment.bars.length; i++) {
    const bar = segment.bars[i]!;
    const symbol = bar.chords[0];
    if (!symbol) {
      throw new Error(
        `generateVocalMelody: segment "${segment.name}" bar ${i} has no chord`,
      );
    }
    ChordSymbolSchema.parse(symbol);
    parseChord(symbol);
  }

  const bars: VocalBar[] = segment.bars.map(() => ({ notes: {} }));
  const laid = expandMergedToSegment(merged, segment.bars.length).sort(
    (a, b) => a.barIndex - b.barIndex || a.beat - b.beat,
  );
  // Into the key, at the octave where the kind's peak fits the range; other
  // kinds than the chorus are re-fitted and smoothed (fit.ts).
  // The ceiling is the one the melody was placed with when that is above the default (hooks: hooks.maxNote), so a
  // hook is not dropped an octave below the range; legacy entries (maxNote at or below MAX_NOTE) are unchanged.
  const ceiling = Math.max(MAX_NOTE, merged.properties.maxNote);
  const shift = sectionTransposition(merged.properties.melodyMaxNote, keyOffset, ceiling);
  let midis = laid.map((ev) => ev.midi + shift);
  if (kind !== 'chorus') {
    const chordAt = (i: number) => {
      const ev = laid[i]!;
      const chords = segment.bars[ev.barIndex]?.chords;
      const chord = chords?.[Math.min(chords.length - 1, Math.floor(ev.beat))];
      if (!chord) throw new Error(`generateVocalMelody: no chord under the note at bar ${ev.barIndex} beat ${ev.beat} of ${segment.name}`);
      return chord;
    };
    midis = refitNonChorus(midis, kind, merged.properties.maxNote, chordAt, keyOffset);
  } else if (Math.min(...midis) < MIN_NOTE) {
    // The key is fixed (legacy moved the whole song so the chorus peak sat on
    // the top note): when that leaves chorus notes under the range, re-fit
    // its octaves within the range, preferring high notes.
    midis = fitRange(midis, 'highNotes', ceiling);
  }
  const events = laid.map((ev, i) => ({ ...ev, midi: midis[i]! }));

  for (const ev of events) {
    if (ev.barIndex < 0 || ev.barIndex >= bars.length) continue;
    const bar = bars[ev.barIndex]!;
    const evt: VocalNoteEvent = {
      type: 'vocalNote',
      // Legacy note-table index → MIDI (range.ts).
      note: MidiNoteSchema.parse(ev.midi + LEGACY_INDEX_TO_MIDI),
      duration: ev.duration,
    };
    const key = BarBeatSchema.parse(formatBarBeat(ev.beat));
    const existing = bar.notes[key];
    if (existing) existing.push(evt);
    else bar.notes[key] = [evt];
  }
  return { segmentName: segment.name, bars };
}

/**
 * The melody chosen for each sung section type (by its first section), before any lyrics-first rhythm is laid under
 * it: the precedent selection, a new melody's own stream (melody variants), a hummed chorus. `rng` is the vocals
 * stream (`ctx.rng.fork('vocals')`), consumed exactly as before. Undefined for a type the banks have no melody for.
 */
export function sectionMelodies(ctx: GeneratorContext, structure: SongStructure, rng: ReturnType<GeneratorContext['rng']['fork']>): Map<string, MergedPrecedent | undefined> {
  // A user chorus (hum to song: params.params.userChorus) takes the chorus's place.
  const cachedBySegmentType = new Map<string, MergedPrecedent | undefined>();
  const userChorus = userChorusOf(ctx.params.params);
  const melodyVariants = melodyVariantsOf(ctx.params.params);
  if (userChorus) cachedBySegmentType.set('chorus', userChorusPrecedent(userChorus, ctx.params.key));
  for (const segment of structure) {
    if (!isSungSegment(segment.name)) continue;
    const segmentType = baseType(segment.name);
    if (cachedBySegmentType.has(segmentType)) continue;
    let merged: MergedPrecedent | undefined;
    {
      const select = (from: typeof rng) =>
        selectMergedPrecedent({
          desiredPatternLength: segment.bars.length,
          segmentType,
          genre: ctx.params.genre,
          tempo: ctx.params.bpm,
          rng: from,
        });
      merged = select(rng);
      // A new melody (Change melody): the type's own stream picks it; the shared draw above still happens, so no
      // other section's melody moves.
      const variant = melodyVariants[segmentType];
      if (variant !== undefined) merged = select(ctx.rng.fork(`vocals/melody/${segmentType}#v${variant}`));
      cachedBySegmentType.set(segmentType, merged);
    }
  }
  return cachedBySegmentType;
}
