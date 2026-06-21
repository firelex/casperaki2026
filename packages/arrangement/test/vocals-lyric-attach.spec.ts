// Step 17c — unit tests for scaffolding + syllabify + seed-phrase picker.
//
// The end-to-end golden + invariant tests live in `vocals.spec.ts`. This
// file pins the smaller building blocks that 17d (backings) and 17e
// (rhyme-control) will consume.

import { describe, expect, it } from 'vitest';

import { createRng } from '@casperaki/music-theory';

import {
  buildVocalScaffolding,
  loadSeedPhrasesBank,
  loadSyllableBank,
  selectSeedPhrasePlan,
  splitWordToSyllables,
  syllabifyPhrase,
} from '../src/index.js';
import { applyLyricsToSegments } from '../src/vocals/syllabify.js';
import type { VocalResult } from '../src/index.js';

function makeFakeResult(): VocalResult {
  // Tiny 1-segment 2-bar result with predictable note counts so we can
  // pin scaffolding behavior without driving the full generator.
  return {
    segments: [
      {
        segmentName: 'verse1',
        bars: [
          {
            notes: {
              '0.0': [{ type: 'vocalNote', note: 50, duration: 1 }],
              '1.0': [{ type: 'vocalNote', note: 52, duration: 0.5 }],
              '1.5': [{ type: 'vocalNote', note: 53, duration: 0.5 }],
              '2.0': [{ type: 'vocalNote', note: 55, duration: 2 }],
            },
          },
          {
            notes: {
              '0.0': [{ type: 'vocalNote', note: 52, duration: 2 }],
              '2.0': [{ type: 'vocalNote', note: 50, duration: 2 }],
            },
          },
        ],
      },
    ],
  };
}

describe('buildVocalScaffolding', () => {
  it('classifies syllableType from duration and beat position', () => {
    const scaffolding = buildVocalScaffolding(makeFakeResult());
    const seg = scaffolding[0]!;
    const line = seg.lines[0]!;
    expect(line.length).toBe(6);
    // Bar 0:
    //   beat 0.0, dur 1   → +
    //   beat 1.0, dur 0.5 → +
    //   beat 1.5, dur 0.5 → -
    //   beat 2.0, dur 2   → 0
    expect(line[0]!.syllableType).toBe('+');
    expect(line[1]!.syllableType).toBe('+');
    expect(line[2]!.syllableType).toBe('-');
    expect(line[3]!.syllableType).toBe('0');
  });

  it('marks endOfPhrase on the last note of every bar', () => {
    const scaffolding = buildVocalScaffolding(makeFakeResult());
    const seg = scaffolding[0]!;
    const line = seg.lines[0]!;
    // Bar 0 last note is at index 3 (beat 2.0, dur 2).
    expect(line[3]!.endOfPhrase).toBe(true);
    // Bar 1 last note is at index 5 (beat 2.0, dur 2).
    expect(line[5]!.endOfPhrase).toBe(true);
    // Non-bar-last notes should not be endOfPhrase.
    expect(line[0]!.endOfPhrase).toBe(false);
    expect(line[1]!.endOfPhrase).toBe(false);
    expect(line[2]!.endOfPhrase).toBe(false);
    expect(line[4]!.endOfPhrase).toBe(false);
  });

  it('buckets into 4-bar rhyme lines per segment', () => {
    const result: VocalResult = {
      segments: [
        {
          segmentName: 'verse1',
          bars: Array.from({ length: 8 }, () => ({
            notes: { '0.0': [{ type: 'vocalNote' as const, note: 50, duration: 4 }] },
          })),
        },
      ],
    };
    const scaffolding = buildVocalScaffolding(result);
    expect(scaffolding[0]!.lines.length).toBe(2);
    expect(scaffolding[0]!.lines[0]!.length).toBe(4);
    expect(scaffolding[0]!.lines[1]!.length).toBe(4);
  });
});

describe('splitWordToSyllables', () => {
  it('emits one token per syllable with trailing "-" on non-final tokens', () => {
    const bank = loadSyllableBank();
    const syllables = splitWordToSyllables('walking', bank);
    expect(syllables.length).toBe(2);
    expect(syllables[0]!.fullWord).toBe('Wal-');
    expect(syllables[1]!.fullWord).toBe('King');
    // Phonemes are lowercase ARPAbet — stress digits preserved as in CMU.
    for (const t of syllables) {
      for (const p of t.vocaloidPhonemes) expect(p).toBe(p.toLowerCase());
    }
  });

  it('throws a typed error on a missing word', () => {
    expect(() => splitWordToSyllables('thisdefinitelyisntinthebank')).toThrow(/missing syllable entry/u);
  });
});

describe('syllabifyPhrase', () => {
  it('flattens a multi-word phrase into a flat syllable list', () => {
    const syllables = syllabifyPhrase(['hold', 'on', 'tight']);
    expect(syllables.length).toBe(3);
    expect(syllables.map((s) => s.fullWord)).toEqual(['Hold', 'On', 'Tight']);
  });
});

describe('selectSeedPhrasePlan', () => {
  it('picks one phrase per scaffolded line + caches per segmentType (verse1/verse2 share)', () => {
    const result: VocalResult = {
      segments: [
        {
          segmentName: 'verse1',
          bars: Array.from({ length: 4 }, () => ({
            notes: { '0.0': [{ type: 'vocalNote' as const, note: 50, duration: 4 }] },
          })),
        },
        {
          segmentName: 'verse2',
          bars: Array.from({ length: 4 }, () => ({
            notes: { '0.0': [{ type: 'vocalNote' as const, note: 50, duration: 4 }] },
          })),
        },
      ],
    };
    const scaffolding = buildVocalScaffolding(result);
    const plan = selectSeedPhrasePlan({
      scaffolding,
      genre: 'brightPop',
      rng: createRng('seed-plan-cache').fork('vocals'),
    });
    // verse2 plan must equal verse1 plan (legacy reuse rule).
    expect(plan.segments[0]!.lines[0]!.phrase).toEqual(plan.segments[1]!.lines[0]!.phrase);
  });

  it('different rng seeds produce different phrase picks (probabilistic over the bank)', () => {
    const result: VocalResult = {
      segments: [
        {
          segmentName: 'verse1',
          bars: Array.from({ length: 4 }, () => ({
            notes: { '0.0': [{ type: 'vocalNote' as const, note: 50, duration: 4 }] },
          })),
        },
      ],
    };
    const scaffolding = buildVocalScaffolding(result);
    const tries = ['s1', 's2', 's3', 's4', 's5', 's6'];
    const picks = new Set<string>();
    for (const t of tries) {
      const plan = selectSeedPhrasePlan({
        scaffolding,
        genre: 'brightPop',
        rng: createRng(t).fork('vocals'),
      });
      picks.add(plan.segments[0]!.lines[0]!.phrase.join(' '));
    }
    expect(picks.size).toBeGreaterThan(1);
  });
});

describe('applyLyricsToSegments', () => {
  it('assigns one syllable per note and preserves note count', () => {
    const result = makeFakeResult();
    const scaffolding = buildVocalScaffolding(result);
    const plan = {
      segments: [
        {
          lines: [
            {
              phrase: ['hold', 'on', 'tight'],
              syllables: syllabifyPhrase(['hold', 'on', 'tight']),
            },
          ],
        },
      ],
    };
    const { result: attached } = applyLyricsToSegments(result, scaffolding, plan);
    let total = 0;
    let withLyric = 0;
    for (const seg of attached.segments) {
      for (const bar of seg.bars) {
        for (const key of Object.keys(bar.notes)) {
          for (const ev of bar.notes[key as keyof typeof bar.notes]!) {
            total++;
            if (ev.type === 'vocalNote' && ev.fullWord && ev.fullWord.length > 0) {
              withLyric++;
            }
          }
        }
      }
    }
    expect(total).toBe(6);
    expect(withLyric).toBe(6);
  });

  it('cycles when phrase has fewer syllables than notes', () => {
    const result = makeFakeResult();
    const scaffolding = buildVocalScaffolding(result);
    const plan = {
      segments: [
        {
          lines: [
            {
              phrase: ['hold', 'on'],
              syllables: syllabifyPhrase(['hold', 'on']),
            },
          ],
        },
      ],
    };
    const { result: attached, report } = applyLyricsToSegments(result, scaffolding, plan);
    expect(report.segments[0]!.lines[0]!.cycled).toBe(true);
    expect(report.segments[0]!.lines[0]!.truncated).toBe(false);
    // Walk the events in order; tokens should cycle [Hold, On, Hold, On, ...].
    const tokens: string[] = [];
    for (const bar of attached.segments[0]!.bars) {
      const keys = Object.keys(bar.notes).sort((a, b) => parseFloat(a) - parseFloat(b));
      for (const key of keys) {
        for (const ev of bar.notes[key as keyof typeof bar.notes]!) {
          if (ev.type === 'vocalNote' && ev.fullWord) tokens.push(ev.fullWord);
        }
      }
    }
    expect(tokens).toEqual(['Hold', 'On', 'Hold', 'On', 'Hold', 'On']);
  });

  it('truncates when phrase has more syllables than notes', () => {
    const result: VocalResult = {
      segments: [
        {
          segmentName: 'verse1',
          bars: [
            {
              notes: {
                '0.0': [{ type: 'vocalNote', note: 50, duration: 4 }],
              },
            },
          ],
        },
      ],
    };
    const scaffolding = buildVocalScaffolding(result);
    const plan = {
      segments: [
        {
          lines: [
            {
              phrase: ['hold', 'on', 'tight'],
              syllables: syllabifyPhrase(['hold', 'on', 'tight']),
            },
          ],
        },
      ],
    };
    const { report } = applyLyricsToSegments(result, scaffolding, plan);
    expect(report.segments[0]!.lines[0]!.truncated).toBe(true);
    expect(report.segments[0]!.lines[0]!.cycled).toBe(false);
  });
});

describe('seed-phrase bank integrity', () => {
  it('every seed-phrase word resolves in the trimmed syllable bank', () => {
    const seedBank = loadSeedPhrasesBank();
    const sylBank = loadSyllableBank();
    const missing: string[] = [];
    for (const genre of Object.keys(seedBank.phrases)) {
      for (const segmentType of Object.keys(seedBank.phrases[genre]!)) {
        for (const phrase of seedBank.phrases[genre]![segmentType]!) {
          for (const word of phrase.words) {
            const sanitized = word.replace(/[^A-Za-z']/gu, '').toLowerCase();
            if (!sylBank.entries[sanitized]) missing.push(`${genre}/${segmentType}: ${word}`);
          }
        }
      }
    }
    expect(missing, `missing syllable entries: ${missing.join(', ')}`).toEqual([]);
  });

  it('all 8 supported genres have at least one phrase per sung segmentType', () => {
    const seedBank = loadSeedPhrasesBank();
    const sungTypes = ['verse', 'preChorus', 'chorus', 'bridge'] as const;
    const supportedGenres = [
      'ballad',
      'brightPop',
      'edm',
      'latin',
      'organicVibes',
      'rock',
      'schlager',
      'urban',
    ] as const;
    for (const genre of supportedGenres) {
      expect(seedBank.phrases[genre], `missing genre ${genre}`).toBeDefined();
      for (const seg of sungTypes) {
        const pool = seedBank.phrases[genre]![seg];
        expect(pool, `missing ${genre}/${seg}`).toBeDefined();
        expect(pool!.length).toBeGreaterThan(0);
      }
    }
  });
});
