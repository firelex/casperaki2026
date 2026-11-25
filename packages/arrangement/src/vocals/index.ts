// Step 17c — syllable-aware lyric attach.
//
// The pre-17c slice (still visible in the 17b commit) generated vocal
// notes via the precedent dispatcher and then cycled a single hard-coded
// 8-word brightPop phrase across every emitted note. Step 17c replaces
// that placeholder with the legacy `Lyricist` data flow:
//
//   1. Generate the vocal melody (precedent dispatcher — 17b, unchanged).
//   2. `buildVocalScaffolding(result)` — ports the
//      `Lyricist._extractMelodyFromSong` walk; emits per-segment lists of
//      4-bar rhyme-lines, each line a flat list of per-note
//      `{ syllableType, endOfPhrase, … }` records.
//   3. `selectSeedPhrasePlan({ scaffolding, genre, rng })` — Path A
//      deterministic phrase author (53af §3a/§4a). Pre-syllabifies each
//      chosen phrase via the trimmed `data/lyrics/syllables.json` bank.
//      Same-segmentType reuse mirrors legacy `Lyricist._insertLyricsIntoSong`
//      (lyricist.js:340-356): `verse1 / verse2` share, `chorus1..N` share.
//   4. `applyLyricsToSegments(result, scaffolding, plan)` — walks the
//      generated note grid in order and attaches one syllable token per
//      note. `endOfPhrase` is taken from the scaffolding (legacy: last
//      note of every bar).
//
// Determinism: still ONE rng fork (`ctx.rng.fork('vocals')`), shared
// between the precedent dispatcher and the seed-phrase picker. The
// picker draws one `rng.pick` per rhyme-line per UNIQUE segmentType —
// reused segments consume no further draws (matches legacy reuse).

import { ChordSymbolSchema, type SongStructure } from '@casperaki/song-schema';
import { parseChord } from '@casperaki/music-theory';

import type { GeneratorContext } from '../context.js';
import {
  BACKING_OFFSET_1,
  BACKING_OFFSET_2,
  generateBackings,
} from './backing.js';
import { userChorusOf, userChorusPrecedent } from '../hum/user-chorus.js';
import { selectSeedPhrasePlan } from './lyrics-source/seed.js';
import { expandMergedToSegment, selectMergedPrecedent, type MergedPrecedent } from './precedents.js';
import { buildVocalScaffolding } from './scaffolding.js';
import { buildContour } from './contour.js';
import { LEGACY_INDEX_TO_MIDI, MAX_NOTE, MIN_NOTE } from './range.js';
import { fitRange, keyOffsetFromC, mergedChordBars, refitNonChorus, sectionTransposition, transposeChordSymbol } from './fit.js';
import { applyLyricsToSegments } from './syllabify.js';
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

  // Phase 1 — vocal melody from precedents (Step 17b, unchanged). A user chorus
  // (hum to song: params.params.userChorus) takes the chorus's place.
  const cachedBySegmentType = new Map<string, MergedPrecedent | undefined>();
  const userChorus = userChorusOf(ctx.params.params);
  const melodyVariants = melodyVariantsOf(ctx.params.params);
  if (userChorus) cachedBySegmentType.set('chorus', userChorusPrecedent(userChorus, ctx.params.key));
  const skeleton: VocalSegment[] = [];
  const sung = new Map<string, { merged: MergedPrecedent; type: string }>();
  for (const segment of structure) {
    if (!isSungSegment(segment.name)) continue;
    const segmentType = baseType(segment.name);
    let merged = cachedBySegmentType.get(segmentType);
    if (!cachedBySegmentType.has(segmentType)) {
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
    if (!merged) continue;
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

  // Phase 2 — lyric scaffolding + seed-phrase pick + per-note attach.
  const skeletonResult: VocalResult = { segments: skeleton };
  const scaffolding = buildVocalScaffolding(skeletonResult);
  const plan = selectSeedPhrasePlan({
    scaffolding,
    genre: ctx.params.genre,
    rng,
  });
  const { result: bankResult } = applyLyricsToSegments(skeletonResult, scaffolding, plan);
  // Written lyrics (generator params `lyrics`, see written-lyrics.ts) replace the phrase bank's words in their
  // sections; the phrase bank's words are only the first pass the brain hands to the lyricist.
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
          ? attachWrittenLyrics(s, written[s.segmentName]!)
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
