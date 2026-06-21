// Step 17e - dirty-rhyme / rhyme-control layer unit tests.
//
// Covers:
//   - data load + bucket index integrity
//   - RhymeIndex.bucket + bucketOfLastWord on known words
//   - RhymeIndex.rhymesWith on known-legacy dirty-rhyme pairs
//   - phrase-pair selection chooses a rhyming second line when available
//   - deterministic same-seed behaviour
//   - cross-seed variation when multiple candidates exist
//   - documented fallback when no rhyme candidate exists

import { describe, expect, it } from 'vitest';

import { createRng } from '@casperaki/music-theory';

import {
  buildVocalScaffolding,
  getRhymeIndex,
  loadDirtyRhymesBank,
  RhymeIndex,
  selectSeedPhrasePlanWithReport,
  type SeedPhrasesBank,
  type VocalResult,
} from '../src/index.js';
import { loadSyllableBank } from '../src/vocals/syllabify.js';
import { applyLyricsToSegments } from '../src/vocals/syllabify.js';

// ─── Data + bucket index integrity ───────────────────────────────────────

describe('RhymeIndex data load', () => {
  it('loads + validates the dirty-rhyme bank', () => {
    const bank = loadDirtyRhymesBank();
    expect(bank.$schemaVersion).toBe(1);
    expect(Object.keys(bank.groupsBySyllableCount).sort()).toEqual(['1', '2']);
    // Sanity: legacy has 63 single-syllable groups + 10 two-syllable groups.
    expect(bank.groupsBySyllableCount['1']!.length).toBe(63);
    expect(bank.groupsBySyllableCount['2']!.length).toBe(10);
  });

  it('builds the bucket lookup with the expected group count', () => {
    const idx = getRhymeIndex();
    expect(idx.groupCount).toBe(73);
  });
});

// ─── bucketOfLastWord ────────────────────────────────────────────────────

describe('RhymeIndex.bucket / bucketOfLastWord', () => {
  it('returns a stable bucket for a single-syllable word', () => {
    const idx = getRhymeIndex();
    const b = idx.bucket('tight');
    expect(b).not.toBeNull();
    // "tight" → tail "AY1 T" → grouped (legacy dirty-rhyme bucket).
    expect(b!.startsWith('Group ')).toBe(true);
  });

  it('returns a non-grouped raw tail when the word does not fall in any group', () => {
    const idx = getRhymeIndex();
    // "day" → tail "EY1" - the table has no bare-vowel group; falls
    // through to the raw tail string per `_getRelevantPhoneme` legacy.
    expect(idx.bucket('day')).toBe('EY1');
  });

  it('returns null for an unknown word', () => {
    const idx = getRhymeIndex();
    expect(idx.bucket('xyzznotaword')).toBeNull();
  });

  it('bucketOfLastWord picks the LAST word of a phrase', () => {
    const idx = getRhymeIndex();
    expect(idx.bucketOfLastWord(['hold', 'on', 'tight'])).toBe(idx.bucket('tight'));
    expect(idx.bucketOfLastWord('walking through the golden day')).toBe(idx.bucket('day'));
  });

  it('strips trailing punctuation / case when matching', () => {
    const idx = getRhymeIndex();
    expect(idx.bucketOfLastWord('hold on Tight!')).toBe(idx.bucket('tight'));
  });
});

// ─── rhymesWith ──────────────────────────────────────────────────────────

describe('RhymeIndex.rhymesWith (known legacy dirty-rhyme pairs)', () => {
  it('rhymes tonight ↔ tight (same AY1 T group)', () => {
    const idx = getRhymeIndex();
    expect(idx.rhymesWith('tonight', 'tight')).toBe(true);
  });

  it('rhymes day ↔ way (same bare-vowel "EY1" tail)', () => {
    const idx = getRhymeIndex();
    expect(idx.rhymesWith('day', 'way')).toBe(true);
  });

  it('rhymes fly ↔ high ↔ my ↔ sky (same "AY1" tail)', () => {
    const idx = getRhymeIndex();
    expect(idx.rhymesWith('fly', 'high')).toBe(true);
    expect(idx.rhymesWith('high', 'my')).toBe(true);
    expect(idx.rhymesWith('my', 'sky')).toBe(true);
  });

  it('does not rhyme cross-bucket pairs', () => {
    const idx = getRhymeIndex();
    expect(idx.rhymesWith('tight', 'day')).toBe(false);
    expect(idx.rhymesWith('fly', 'tonight')).toBe(false);
  });

  it('returns false when either side is missing from the bank', () => {
    const idx = getRhymeIndex();
    expect(idx.rhymesWith('tight', 'xyzznotaword')).toBe(false);
    expect(idx.rhymesWith('xyzznotaword', 'tight')).toBe(false);
  });
});

// ─── phrase-pair selection ──────────────────────────────────────────────

function eightBarResult(name: string): VocalResult {
  // 4-bar segment yields a single rhyme-line in the scaffolding - we
  // need an 8-bar segment to exercise rhyme-line-2 (line index 1) since
  // the scaffolding buckets every 4 bars into one rhyme-line.
  return {
    segments: [
      {
        segmentName: name,
        bars: Array.from({ length: 8 }, () => ({
          notes: { '0.0': [{ type: 'vocalNote' as const, note: 50, duration: 4 }] },
        })),
      },
    ],
  };
}

describe('selectSeedPhrasePlan rhyme-line-2 filter', () => {
  it('chooses a rhyming second line when the pool offers a rhyme candidate', () => {
    // Custom bank: line 1 free pick is one of two phrases ending in `tight`
    // / `tonight` (both bucket = AY1 T group). Whichever phrase line 0
    // lands on, line 1 must end in a word that rhymes - and BOTH pool
    // entries do, so the filter never falls back.
    const result = eightBarResult('verse1');
    const scaffolding = buildVocalScaffolding(result);
    const bank: SeedPhrasesBank = {
      $schemaVersion: 1,
      phrases: {
        brightPop: {
          verse: [
            { words: ['hold', 'on', 'tight'] },
            { words: ['tonight'] },
          ],
        },
      },
    };
    // Run several seeds; every line 1 last-word must rhyme with its line 0
    // last-word, and `usedFallback` must be false on every report.
    let rhymedCount = 0;
    let fallbackCount = 0;
    for (const seed of ['s1', 's2', 's3', 's4', 's5', 's6']) {
      const rng = createRng(seed).fork('vocals');
      const { rhymeReport } = selectSeedPhrasePlanWithReport({
        scaffolding,
        genre: 'brightPop',
        rng,
        bank,
      });
      const lines = rhymeReport.segments[0]!.lines;
      const line1 = lines[1]!;
      if (line1.usedFallback) fallbackCount++;
      if (line1.rhymed) rhymedCount++;
    }
    expect(rhymedCount).toBe(6);
    expect(fallbackCount).toBe(0);
  });

  it('falls back to the unfiltered pool when no rhyme candidate exists', () => {
    // Pool of two phrases ending in "tonight" + "day" - they live in
    // different buckets, so line 1 NEVER finds a rhyme candidate and the
    // picker reports `usedFallback: true` on every seed.
    const result = eightBarResult('verse1');
    const scaffolding = buildVocalScaffolding(result);
    const bank: SeedPhrasesBank = {
      $schemaVersion: 1,
      phrases: {
        brightPop: {
          verse: [
            { words: ['hold', 'on', 'tonight'] },
            { words: ['brand', 'new', 'day'] },
          ],
        },
      },
    };
    for (const seed of ['fb-1', 'fb-2', 'fb-3']) {
      const rng = createRng(seed).fork('vocals');
      const { rhymeReport, plan } = selectSeedPhrasePlanWithReport({
        scaffolding,
        genre: 'brightPop',
        rng,
        bank,
      });
      const lines = rhymeReport.segments[0]!.lines;
      expect(lines[0]!.isRhymeLine2).toBe(false);
      expect(lines[1]!.isRhymeLine2).toBe(true);
      expect(lines[1]!.usedFallback).toBe(true);
      // The plan still emits a non-empty syllable list on line 1.
      expect(plan.segments[0]!.lines[1]!.syllables.length).toBeGreaterThan(0);
    }
  });

  it('same seed twice -> byte-identical plan + rhymeReport', () => {
    const result = eightBarResult('verse1');
    const scaffolding = buildVocalScaffolding(result);
    const make = () =>
      selectSeedPhrasePlanWithReport({
        scaffolding,
        genre: 'brightPop',
        rng: createRng('determinism-seed').fork('vocals'),
      });
    const a = make();
    const b = make();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('different seeds choose different rhyme candidates when the pool offers >1 rhyming option', () => {
    // brightPop chorus pool has TWO phrases that both rhyme with each
    // other ("hold on tight tonight" / "rise and hold on tight"). With
    // both passing the rhyme filter, cross-seed picks must surface
    // BOTH last words across a handful of seeds.
    const result: VocalResult = {
      segments: [
        {
          segmentName: 'chorus1',
          bars: Array.from({ length: 8 }, () => ({
            notes: { '0.0': [{ type: 'vocalNote' as const, note: 50, duration: 4 }] },
          })),
        },
      ],
    };
    const scaffolding = buildVocalScaffolding(result);
    const lastWords = new Set<string>();
    for (const seed of ['v-a', 'v-b', 'v-c', 'v-d', 'v-e', 'v-f']) {
      const rng = createRng(seed).fork('vocals');
      const { plan } = selectSeedPhrasePlanWithReport({
        scaffolding,
        genre: 'brightPop',
        rng,
      });
      for (const line of plan.segments[0]!.lines) {
        lastWords.add(line.phrase[line.phrase.length - 1]!);
      }
    }
    expect(lastWords.size).toBeGreaterThan(1);
  });
});

// ─── syllable-attach + backings still happy ──────────────────────────────

describe('lyric attach + backings still happy under rhyme-aware seed pick', () => {
  it('every emitted note carries non-empty syllable phonemes', () => {
    const result = eightBarResult('chorus1');
    const scaffolding = buildVocalScaffolding(result);
    const { plan } = selectSeedPhrasePlanWithReport({
      scaffolding,
      genre: 'brightPop',
      rng: createRng('phoneme-after-rhyme').fork('vocals'),
    });
    const { result: attached } = applyLyricsToSegments(result, scaffolding, plan);
    let total = 0;
    for (const seg of attached.segments) {
      for (const bar of seg.bars) {
        for (const k of Object.keys(bar.notes)) {
          for (const ev of bar.notes[k as keyof typeof bar.notes]!) {
            total++;
            if (ev.type === 'vocalNote') {
              expect(ev.fullWord).toBeDefined();
              expect(ev.vocaloidPhonemes).toBeDefined();
              expect(ev.vocaloidPhonemes!.length).toBeGreaterThan(0);
            }
          }
        }
      }
    }
    expect(total).toBeGreaterThan(0);
  });
});

// ─── Standalone constructor usage ────────────────────────────────────────

describe('RhymeIndex constructor', () => {
  it('returns the same bucket as the cached singleton for known inputs', () => {
    const idx = new RhymeIndex(loadSyllableBank(), loadDirtyRhymesBank());
    const singleton = getRhymeIndex();
    for (const word of ['tight', 'tonight', 'day', 'way', 'fly', 'high', 'love']) {
      expect(idx.bucket(word)).toBe(singleton.bucket(word));
    }
  });
});
