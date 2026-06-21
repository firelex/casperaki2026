// Step 17c - deterministic per-(genre x segmentType) seed-phrase picker.
// Step 17e - rhyme-aware filter on rhyme-line-2.
//
// The 53af plan calls out three lyric authoring paths; this is "Path A,
// deterministic seed phrases" (§3a). LLM authoring (Path B) lands later
// via cached `Song.aiArtifacts` per 53af §4d / 17f+.
//
// Picker contract:
//   - Input:  scaffolding (per segment, list of 4-bar rhyme-lines).
//   - Output: PhrasePlan (per segment, list of per-line phrase choices,
//             pre-syllabified).
//   - Randomness: ONE `rng.pick` draw per line over the (genre,
//     segmentType) phrase pool.
//   - Rhyme: for every EVEN line index (0, 2, ...) the pick is "free" -
//     drawn from the full pool. For every ODD line index (1, 3, ...) the
//     pool is first filtered to phrases whose last-word rhyme bucket
//     matches the previous line's last-word bucket (the dirty-rhyme
//     `_getRelevantPhoneme` equivalence class). If the filtered pool is
//     empty (no rhyming candidate available), the pick falls back to the
//     full unfiltered pool - the fallback is logged via the returned
//     `PhrasePlan.rhymeReport` so tests + future LLM authors can detect
//     the case. This mirrors legacy `TemplatePoetVerseClass` lines 328-338
//     (`isRhymeLine2` filter on `relevantPhoneme === currentRhymePhoneme`)
//     without porting the rest of the TemplatePoet authoring pipeline.
//
// Determinism: the picker consumes the existing `ctx.rng.fork('vocals')`
// stream from the caller - no new fork salt is introduced (53af §3d).
// One `rng.pick` per line per UNIQUE segmentType, regardless of whether
// the rhyme filter fires - this keeps the RNG-draw count stable across
// seed-bank curation passes.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import type { Rng } from '@casperaki/music-theory';

import { DataAssetError, type DataAssetMeta } from '../../data/loader.js';
import { getRhymeIndex, type RhymeIndex } from '../rhyme.js';
import type { VocalScaffolding } from '../scaffolding.js';
import {
  loadSyllableBank,
  syllabifyPhrase,
  type PhrasePlan,
  type PhrasePlanLine,
  type SyllableBank,
} from '../syllabify.js';

const SeedPhraseSchema = z
  .object({ words: z.array(z.string().min(1)).min(1) })
  .strict();

const SeedPhrasesByGenreSchema = z.record(
  z.string().min(1),
  z.record(z.string().min(1), z.array(SeedPhraseSchema).min(1)),
);

const SeedPhrasesBankSchema = z
  .object({
    $schemaVersion: z.literal(1),
    $description: z.string().optional(),
    $legacySource: z.string().optional(),
    $extractedAt: z.string().optional(),
    phrases: SeedPhrasesByGenreSchema,
  })
  .strict();

export type SeedPhrase = z.infer<typeof SeedPhraseSchema>;
export type SeedPhrasesBank = z.infer<typeof SeedPhrasesBankSchema>;

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(HERE, '..', '..', '..', 'data', 'lyrics');

const SEED_META: DataAssetMeta = {
  filename: 'seed-phrases.json',
  legacyPath:
    'casperaki2-engine-js/api/v1.0/services/data/lyrics/database/loveSongs (TemplatePoetClass approximation)',
  extractedAt: '2026-06-07',
};

let cachedBank: SeedPhrasesBank | undefined;

export function loadSeedPhrasesBank(): SeedPhrasesBank {
  if (cachedBank) return cachedBank;
  const path = resolve(DATA_DIR, SEED_META.filename);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new DataAssetError(SEED_META, `failed to load: ${(err as Error).message}`, err);
  }
  const parsed = SeedPhrasesBankSchema.safeParse(raw);
  if (!parsed.success) {
    throw new DataAssetError(SEED_META, `invalid bank shape: ${parsed.error.message}`);
  }
  cachedBank = parsed.data;
  return cachedBank;
}

/** Mirrors `baseType` in `vocals/index.ts` - `chorus2` -> `chorus`. */
function baseType(name: string): string {
  const m = /^[A-Za-z]+/u.exec(name);
  return m ? m[0]! : name;
}

/** Diagnostic emitted alongside the phrase plan so callers / tests can
 *  inspect which rhyme-line-2 picks ended up using the dirty-rhyme
 *  filter, which fell back, and the bucket each anchor / pick resolved
 *  to. Future LLM authoring (17f+) consumes the same shape as the
 *  post-response validator output. */
export interface RhymeLineReport {
  readonly lineIndex: number;
  readonly isRhymeLine2: boolean;
  readonly anchorWord: string | null;
  readonly anchorBucket: string | null;
  readonly pickedWord: string | null;
  readonly pickedBucket: string | null;
  readonly poolSize: number;
  readonly filteredSize: number;
  readonly usedFallback: boolean;
  readonly rhymed: boolean;
}

export interface RhymeReport {
  readonly segments: readonly {
    readonly segmentName: string;
    readonly lines: readonly RhymeLineReport[];
  }[];
}

export interface SelectInputs {
  readonly scaffolding: VocalScaffolding;
  readonly genre: string;
  readonly rng: Rng;
  readonly bank?: SeedPhrasesBank;
  readonly syllableBank?: SyllableBank;
  readonly rhymeIndex?: RhymeIndex;
}

export interface SeedPhrasePlanResult {
  readonly plan: PhrasePlan;
  readonly rhymeReport: RhymeReport;
}

/** Selects one seed phrase per scaffolded rhyme-line.
 *
 *  Same-segmentType reuse: legacy `Lyricist._insertLyricsIntoSong`
 *  (lyricist.js:340-356) caches the picked phrases per segmentType so
 *  `verse1` / `verse2` share AND `chorus1..N` share. The seed picker
 *  replicates that here: only the FIRST occurrence of a segmentType
 *  draws from the rng; later occurrences re-use the cached plan.
 *
 *  Rhyme-line-2 filter (Step 17e): for ODD line indices the candidate
 *  pool is filtered by `rhymeIndex.rhymesWith(candidateLastWord,
 *  anchorLastWord)`. If the filtered pool is non-empty, the pick draws
 *  from it; otherwise the draw falls back to the unfiltered pool and
 *  `usedFallback` is set on the corresponding `RhymeLineReport`. Both
 *  paths consume exactly one `rng.pick` so the RNG-draw count stays
 *  stable across seed-bank curation passes. */
export function selectSeedPhrasePlan(inputs: SelectInputs): PhrasePlan {
  return selectSeedPhrasePlanWithReport(inputs).plan;
}

/** Same as `selectSeedPhrasePlan` but also returns the rhyme diagnostic.
 *  Callers that just need the plan (the generator) use the wrapper above;
 *  tests + the 17f+ LLM-author validator use the full shape. */
export function selectSeedPhrasePlanWithReport(
  inputs: SelectInputs,
): SeedPhrasePlanResult {
  const bank = inputs.bank ?? loadSeedPhrasesBank();
  const syllableBank = inputs.syllableBank ?? loadSyllableBank();
  const rhymeIndex = inputs.rhymeIndex ?? getRhymeIndex();
  const genrePhrases = bank.phrases[inputs.genre];
  if (!genrePhrases) {
    throw new DataAssetError(
      SEED_META,
      `no seed-phrase bank for genre "${inputs.genre}"`,
    );
  }

  interface CachedPlan {
    readonly lines: readonly PhrasePlanLine[];
    readonly reports: readonly RhymeLineReport[];
  }
  const cachedBySegmentType = new Map<string, CachedPlan>();
  const planSegments: { lines: readonly PhrasePlanLine[] }[] = [];
  const reportSegments: RhymeReport['segments'][number][] = [];

  for (const seg of inputs.scaffolding) {
    const segmentType = baseType(seg.segmentName);
    const cached = cachedBySegmentType.get(segmentType);
    if (cached) {
      const lines = padOrTrimLines(cached.lines, seg.lines.length);
      planSegments.push({ lines });
      reportSegments.push({
        segmentName: seg.segmentName,
        lines: padOrTrimReports(cached.reports, seg.lines.length),
      });
      continue;
    }
    const pool = genrePhrases[segmentType];
    if (!pool || pool.length === 0) {
      throw new DataAssetError(
        SEED_META,
        `no seed phrases for ${inputs.genre}/${segmentType}`,
      );
    }
    const lines: PhrasePlanLine[] = [];
    const reports: RhymeLineReport[] = [];
    let previousAnchorWord: string | null = null;
    let previousAnchorBucket: string | null = null;
    for (let i = 0; i < seg.lines.length; i++) {
      const isRhymeLine2 = i > 0 && i % 2 === 1;
      let candidatePool: readonly SeedPhrase[] = pool;
      let filteredSize = pool.length;
      let usedFallback = false;
      if (isRhymeLine2 && previousAnchorBucket !== null) {
        // Legacy TemplatePoetVerseClass.js:334 also excludes candidates
        // whose last word equals the anchor's last word
        // (`v['relevantWord'] === parent.currentRhymeWord`). We mirror
        // that here so a 2-phrase pool with one rhyming pair surfaces the
        // pair, not the same phrase twice.
        const filtered = pool.filter((p) =>
          phraseRhymesWith(p, previousAnchorWord, previousAnchorBucket!, rhymeIndex),
        );
        filteredSize = filtered.length;
        if (filtered.length > 0) {
          candidatePool = filtered;
        } else {
          usedFallback = true;
        }
      } else if (isRhymeLine2) {
        // Anchor word had no resolvable bucket - rhyme filter cannot run.
        usedFallback = true;
      }
      const pick = inputs.rng.pick([...candidatePool]);
      const syllables = syllabifyPhrase(pick.words, syllableBank);
      lines.push({ phrase: [...pick.words], syllables });
      const pickedWord = lastWord(pick);
      const pickedBucket = pickedWord ? rhymeIndex.bucket(pickedWord) : null;
      reports.push({
        lineIndex: i,
        isRhymeLine2,
        anchorWord: isRhymeLine2 ? previousAnchorWord : null,
        anchorBucket: isRhymeLine2 ? previousAnchorBucket : null,
        pickedWord,
        pickedBucket,
        poolSize: pool.length,
        filteredSize,
        usedFallback,
        rhymed:
          isRhymeLine2 &&
          previousAnchorBucket !== null &&
          pickedBucket !== null &&
          previousAnchorBucket === pickedBucket,
      });
      previousAnchorWord = pickedWord;
      previousAnchorBucket = pickedBucket;
    }
    cachedBySegmentType.set(segmentType, { lines, reports });
    planSegments.push({ lines });
    reportSegments.push({ segmentName: seg.segmentName, lines: reports });
  }

  return {
    plan: { segments: planSegments },
    rhymeReport: { segments: reportSegments },
  };
}

function lastWord(phrase: SeedPhrase): string | null {
  for (let i = phrase.words.length - 1; i >= 0; i--) {
    const w = phrase.words[i]!;
    if (w.replace(/[^A-Za-z']/gu, '').length > 0) return w;
  }
  return null;
}

function sanitize(word: string): string {
  return word.replace(/[^A-Za-z']/gu, '').toLowerCase();
}

function phraseRhymesWith(
  phrase: SeedPhrase,
  anchorWord: string | null,
  anchorBucket: string,
  rhymeIndex: RhymeIndex,
): boolean {
  const last = lastWord(phrase);
  if (!last) return false;
  if (anchorWord && sanitize(last) === sanitize(anchorWord)) return false;
  const b = rhymeIndex.bucket(last);
  return b !== null && b === anchorBucket;
}

function padOrTrimLines(
  cached: readonly PhrasePlanLine[],
  desired: number,
): readonly PhrasePlanLine[] {
  if (cached.length === desired) return cached;
  if (cached.length > desired) return cached.slice(0, desired);
  const out: PhrasePlanLine[] = [...cached];
  while (out.length < desired) out.push(cached[out.length % cached.length]!);
  return out;
}

function padOrTrimReports(
  cached: readonly RhymeLineReport[],
  desired: number,
): readonly RhymeLineReport[] {
  if (cached.length === desired) return cached;
  if (cached.length > desired) return cached.slice(0, desired);
  const out: RhymeLineReport[] = [...cached];
  while (out.length < desired) out.push(cached[out.length % cached.length]!);
  return out;
}
