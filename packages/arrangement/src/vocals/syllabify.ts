// Step 17c — syllable + phoneme attacher.
//
// Legacy source: `Lyricist._insertLyricsIntoSong` (lyricist.js:275-481).
// Per word in the chosen phrase, look up `syllables.json#<word>.syllables`
// + `phonemeSyllables`. Per syllable emit a per-note record:
//
//   {
//     fullWord:  TitleCase(syllable) + ('-' if non-final syllable of word),
//     vocaloidPhonemes: phonemeSyllables[i].split(' ').map(toLowerCase),
//   }
//
// Legacy mapped CMU → X-SAMPA via `cmuToVocaloid.json` for Vocaloid
// rendering. Per the 53af plan the brain port DOES NOT do that mapping —
// `vocaloidPhonemes` carries lowercase ARPAbet directly (legacy field name
// kept for one PR; rename deferred to 17f). The trimmed
// `data/lyrics/syllables.json` companion ships only words used by the seed
// bank — we validate on load that every seed-phrase word resolves.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import {
  BarBeatSchema,
  MidiNoteSchema,
  type VocalNoteEvent,
} from '@casperaki/song-schema';
import { formatBarBeat } from '@casperaki/music-theory';

import { DataAssetError, type DataAssetMeta } from '../data/loader.js';
import type { VocalBar, VocalResult, VocalSegment } from './types.js';
import type { SegmentScaffolding, VocalScaffolding } from './scaffolding.js';

const SyllableEntrySchema = z
  .object({
    syllables: z.array(z.string().min(1)).min(1),
    phonemeSyllables: z.array(z.string().min(1)).min(1),
    numberOfSyllables: z.number().int().positive(),
    rhythm: z.array(z.enum(['+', '-', '0'])).min(1),
  })
  .strict()
  .refine((d) => d.syllables.length === d.phonemeSyllables.length, {
    message: 'syllables / phonemeSyllables length mismatch',
  });

const SyllableBankSchema = z
  .object({
    $schemaVersion: z.literal(1),
    $description: z.string().optional(),
    $legacySource: z.string().optional(),
    $extractedAt: z.string().optional(),
    entries: z.record(z.string().min(1), SyllableEntrySchema),
  })
  .strict();

export type SyllableEntry = z.infer<typeof SyllableEntrySchema>;
export type SyllableBank = z.infer<typeof SyllableBankSchema>;

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(HERE, '..', '..', 'data', 'lyrics');

const SYLLABLES_META: DataAssetMeta = {
  filename: 'syllables.json',
  legacyPath:
    'casperaki2-engine-js/api/v1.0/services/data/lyrics/database/syllables.json',
  extractedAt: '2026-06-07',
};

let cachedBank: SyllableBank | undefined;

export function loadSyllableBank(): SyllableBank {
  if (cachedBank) return cachedBank;
  const path = resolve(DATA_DIR, SYLLABLES_META.filename);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new DataAssetError(SYLLABLES_META, `failed to load: ${(err as Error).message}`, err);
  }
  const parsed = SyllableBankSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DataAssetError(SYLLABLES_META, `invalid bank shape: ${parsed.error.message}`);
  }
  cachedBank = parsed.data;
  return cachedBank;
}

export interface SyllableToken {
  /** Title-case syllable text + trailing '-' if non-final syllable of a word.
   *  Legacy `Lyricist._insertLyricsIntoSong` writes this to `lyrics`; the
   *  brain port stores it in `fullWord` (legacy field-name kept this PR;
   *  rename deferred to 17f per 53af §3c). */
  readonly fullWord: string;
  /** Lowercase ARPAbet phonemes for this syllable. Stored in
   *  `vocaloidPhonemes` (legacy name; rename deferred). No Vocaloid X-SAMPA
   *  mapping is performed — see file header. */
  readonly vocaloidPhonemes: readonly string[];
}

/** Splits a word into syllable tokens via the syllable bank. */
export function splitWordToSyllables(
  word: string,
  bank: SyllableBank = loadSyllableBank(),
): readonly SyllableToken[] {
  const sanitized = word.replace(/[^A-Za-z']/gu, '').toLowerCase();
  const entry = bank.entries[sanitized];
  if (!entry) {
    throw new DataAssetError(
      SYLLABLES_META,
      `missing syllable entry for word "${word}" (sanitized "${sanitized}")`,
    );
  }
  const out: SyllableToken[] = [];
  for (let i = 0; i < entry.syllables.length; i++) {
    const syllable = entry.syllables[i]!;
    const isFinal = i === entry.syllables.length - 1;
    const titleCased = titleCase(i === 0 ? syllable : syllable);
    out.push({
      fullWord: isFinal ? titleCased : `${titleCased}-`,
      vocaloidPhonemes: entry.phonemeSyllables[i]!
        .split(' ')
        .map((p) => p.toLowerCase()),
    });
  }
  return out;
}

function titleCase(s: string): string {
  if (s.length === 0) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Flattens a list of words into a flat list of syllable tokens. Used by
 *  the per-line lyric attach loop. */
export function syllabifyPhrase(
  words: readonly string[],
  bank: SyllableBank = loadSyllableBank(),
): readonly SyllableToken[] {
  const out: SyllableToken[] = [];
  for (const word of words) {
    for (const syl of splitWordToSyllables(word, bank)) {
      out.push(syl);
    }
  }
  return out;
}

/** Per-line syllable plan emitted by the seed-phrase picker (or, later, by
 *  the LLM author). One entry per line in the segment's scaffolding. */
export interface PhrasePlanLine {
  /** Plain English source phrase the syllables came from (for the
   *  testability + golden inspection). */
  readonly phrase: readonly string[];
  /** Flat list of syllable tokens for this line — the attach loop walks
   *  these in lockstep with the scaffolding's note records. */
  readonly syllables: readonly SyllableToken[];
}

export interface PhrasePlan {
  /** Per-segment list of per-line plans, keyed in the same order as the
   *  scaffolding's `segments` and `segments[i].lines`. */
  readonly segments: readonly { readonly lines: readonly PhrasePlanLine[] }[];
}

/** Attach syllables to notes deterministically.
 *
 *  Alignment policy (smallest faithful approximation; documented in
 *  docs/53ag):
 *  - One syllable ↔ one note (legacy invariant).
 *  - If the line plan has FEWER syllables than notes, the syllable list
 *    is cycled (repeated from index 0) until every note carries a
 *    syllable. This matches legacy `TemplatePoetVerseClass`'s fallback
 *    of inserting filler words; we keep it simpler by cycling the
 *    chosen phrase.
 *  - If the line plan has MORE syllables than notes, the trailing
 *    syllables are dropped. The dropped tail is logged in the
 *    returned `AlignmentReport` so callers / tests can flag it.
 *  - `endOfPhrase` is taken VERBATIM from the scaffolding (legacy: last
 *    note of every bar). The lyric layer never resets it. */
export interface AlignmentReport {
  /** Per-segment alignment notes. */
  readonly segments: readonly {
    readonly segmentName: string;
    readonly lines: readonly {
      readonly noteCount: number;
      readonly syllableCount: number;
      readonly cycled: boolean;
      readonly truncated: boolean;
    }[];
  }[];
}

export interface AttachResult {
  readonly result: VocalResult;
  readonly report: AlignmentReport;
}

/** Writes `fullWord` + `vocaloidPhonemes` onto every note of the input
 *  result according to `plan`. The `result` input is treated as immutable
 *  — the returned `VocalResult` is a fresh deep-clone with attached lyric
 *  metadata. */
export function applyLyricsToSegments(
  result: VocalResult,
  scaffolding: VocalScaffolding,
  plan: PhrasePlan,
): AttachResult {
  if (result.segments.length !== scaffolding.length) {
    throw new Error(
      `applyLyricsToSegments: scaffolding length ${scaffolding.length} does not match ${result.segments.length} segments`,
    );
  }
  if (plan.segments.length !== scaffolding.length) {
    throw new Error(
      `applyLyricsToSegments: plan has ${plan.segments.length} segments but scaffolding has ${scaffolding.length}`,
    );
  }
  const outSegments: VocalSegment[] = [];
  const reportSegments: AlignmentReport['segments'][number][] = [];
  for (let s = 0; s < result.segments.length; s++) {
    const seg = result.segments[s]!;
    const segScaffolding = scaffolding[s]!;
    const segPlan = plan.segments[s]!;
    const { segment: attached, lines: lineReports } = attachSegment(
      seg,
      segScaffolding,
      segPlan,
    );
    outSegments.push(attached);
    reportSegments.push({ segmentName: seg.segmentName, lines: lineReports });
  }
  return {
    result: { segments: outSegments },
    report: { segments: reportSegments },
  };
}

/** The notes as they are, without words, each marked endOfPhrase where the scaffolding says (legacy: the last note of
 *  every bar). A melody before its lyrics are written (owner 2026-11-28: "just leave out the lyrics until we've written
 *  them"; the phrase bank's two stand-in lines a section type looped over the notes, broken mid-word). */
export function markPhraseEnds(result: VocalResult, scaffolding: VocalScaffolding): VocalResult {
  if (result.segments.length !== scaffolding.length) {
    throw new Error(`markPhraseEnds: scaffolding length ${scaffolding.length} does not match ${result.segments.length} segments`);
  }
  return {
    segments: result.segments.map((segment, s) => {
      const ends = new Set<string>();
      for (const line of scaffolding[s]!.lines) for (const n of line) if (n.endOfPhrase) ends.add(`${n.barIndex}|${n.beat}`);
      return {
        segmentName: segment.segmentName,
        bars: segment.bars.map((bar, barIndex) => {
          const notes: VocalBar['notes'] = {};
          const keys = Object.keys(bar.notes).map((k) => ({ key: k, beat: parseFloat(k) })).sort((a, b) => a.beat - b.beat);
          for (const { key, beat } of keys) {
            notes[BarBeatSchema.parse(formatBarBeat(beat))] = bar.notes[BarBeatSchema.parse(key)]!.map((ev): VocalNoteEvent => {
              if (ev.type !== 'vocalNote') return ev;
              const { fullWord: _w, vocaloidPhonemes: _p, endOfPhrase: _e, ...rest } = ev;
              return { ...rest, ...(ends.has(`${barIndex}|${beat}`) && { endOfPhrase: true }) };
            });
          }
          return { notes };
        }),
      };
    }),
  };
}

function attachSegment(
  segment: VocalSegment,
  scaffolding: SegmentScaffolding,
  plan: { readonly lines: readonly PhrasePlanLine[] },
): {
  segment: VocalSegment;
  lines: AlignmentReport['segments'][number]['lines'];
} {
  if (scaffolding.lines.length !== plan.lines.length) {
    throw new Error(
      `attachSegment(${segment.segmentName}): plan has ${plan.lines.length} lines but scaffolding has ${scaffolding.lines.length}`,
    );
  }

  // Build an ordered list of (barIndex, beat, syllable, endOfPhrase) tuples
  // by walking each line in scaffolding order and pairing with its plan.
  const lineReports: AlignmentReport['segments'][number]['lines'][number][] = [];
  const assignments = new Map<string, SyllableToken>(); // key = `${barIndex}|${beat}|${nthAtBeat}`

  for (let l = 0; l < scaffolding.lines.length; l++) {
    const line = scaffolding.lines[l]!;
    const phrase = plan.lines[l]!;
    const sylCount = phrase.syllables.length;
    const noteCount = line.length;
    const cycled = sylCount > 0 && sylCount < noteCount;
    const truncated = sylCount > noteCount;
    lineReports.push({ noteCount, syllableCount: sylCount, cycled, truncated });
    if (sylCount === 0) {
      throw new Error(
        `attachSegment(${segment.segmentName}): line ${l} has no syllables in plan`,
      );
    }
    const beatOccurrence = new Map<string, number>();
    for (let n = 0; n < noteCount; n++) {
      const note = line[n]!;
      const baseKey = `${note.barIndex}|${note.beat}`;
      const idx = beatOccurrence.get(baseKey) ?? 0;
      beatOccurrence.set(baseKey, idx + 1);
      const syl = phrase.syllables[n % sylCount]!;
      assignments.set(`${baseKey}|${idx}`, syl);
    }
  }

  // Rebuild the segment by walking the existing bars in beat order and
  // pulling the matching syllable from `assignments`. We also preserve
  // the endOfPhrase flag from scaffolding (legacy: last note of every bar).
  const endOfPhraseSet = new Set<string>();
  for (const line of scaffolding.lines) {
    for (const n of line) {
      if (n.endOfPhrase) endOfPhraseSet.add(`${n.barIndex}|${n.beat}`);
    }
  }

  const outBars: VocalBar[] = [];
  for (let barIndex = 0; barIndex < segment.bars.length; barIndex++) {
    const bar = segment.bars[barIndex]!;
    const newBar: VocalBar = { notes: {} };
    const beatKeys = Object.keys(bar.notes)
      .map((k) => ({ key: k, beat: parseFloat(k) }))
      .sort((a, b) => a.beat - b.beat);
    for (const { key, beat } of beatKeys) {
      const events = bar.notes[BarBeatSchema.parse(key)]!;
      const formatted = formatBarBeat(beat);
      const formattedKey = BarBeatSchema.parse(formatted);
      const outEvents: VocalNoteEvent[] = [];
      let occurrence = 0;
      for (const ev of events) {
        if (ev.type !== 'vocalNote') {
          outEvents.push(ev);
          continue;
        }
        const syl = assignments.get(`${barIndex}|${beat}|${occurrence}`);
        if (!syl) {
          // No syllable plan for this note (e.g. the note appears in the
          // result but not in scaffolding — should not happen in practice,
          // but we keep the event with its existing payload so we never
          // emit a malformed schema).
          outEvents.push(ev);
        } else {
          const isPhraseEnd = endOfPhraseSet.has(`${barIndex}|${beat}`);
          const out: VocalNoteEvent = {
            type: 'vocalNote',
            note: MidiNoteSchema.parse(ev.note),
            duration: ev.duration,
            fullWord: syl.fullWord,
            vocaloidPhonemes: [...syl.vocaloidPhonemes],
            ...(isPhraseEnd && { endOfPhrase: true }),
          };
          outEvents.push(out);
        }
        occurrence++;
      }
      newBar.notes[formattedKey] = outEvents;
    }
    outBars.push(newBar);
  }
  return {
    segment: { segmentName: segment.segmentName, bars: outBars },
    lines: lineReports,
  };
}
