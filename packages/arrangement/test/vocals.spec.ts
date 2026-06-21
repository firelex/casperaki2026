// Step 7 — vocal melody + phoneme generator tests.

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { beatsPerBar, createRng, parseBarBeat } from '@casperaki/music-theory';
import { NoteRefSchema, stableStringify } from '@casperaki/song-schema';

import {
  generateChords,
  generateSongStructure,
  generateVocalMelody,
  VocalResultSchema,
  type GenerateParams,
  type GeneratorContext,
  type VocalResult,
} from '../src/index.js';
import { MIN_NOTE, MAX_NOTE } from '../src/vocals/range.js';
import { vocalsGoldenPath } from './fixtures.js';

function makeCtx(seed: string | number, key = 'C', genre = 'brightPop'): GeneratorContext {
  const params: GenerateParams = { genre, key, bpm: 120, seed };
  return { rng: createRng(seed), params };
}

function generate(seed: string | number, key = 'C'): {
  result: VocalResult;
  structure: ReturnType<typeof generateSongStructure>;
} {
  const ctx = makeCtx(seed, key);
  const structure = generateChords(ctx, generateSongStructure(ctx));
  return { result: generateVocalMelody(ctx, structure), structure };
}

function forEachEvent(
  result: VocalResult,
  cb: (
    event: VocalResult['segments'][number]['bars'][number]['notes'][string][number],
    segmentName: string,
    beatKey: string,
  ) => void,
): void {
  for (const segment of result.segments) {
    for (const bar of segment.bars) {
      for (const [key, events] of Object.entries(bar.notes)) {
        for (const ev of events) cb(ev, segment.segmentName, key);
      }
    }
  }
}

describe('generateVocalMelody (brightPop)', () => {
  it('validates against VocalResultSchema', () => {
    const { result } = generate('schema-check');
    const parsed = VocalResultSchema.safeParse(result);
    if (!parsed.success) console.error(parsed.error.issues);
    expect(parsed.success).toBe(true);
  });

  it('emits vocals on verse / preChorus / chorus / bridge segments only', () => {
    const { result } = generate('coverage-check');
    // Segment-type prefix must be one of the sung roles; intro / outro /
    // break must not appear in the vocal output.
    const SUNG = ['verse', 'preChorus', 'chorus', 'bridge'];
    const isSung = (name: string) => SUNG.some((p) => name.startsWith(p));
    expect(result.segments.length).toBeGreaterThan(0);
    for (const s of result.segments) {
      expect(isSung(s.segmentName), `unexpected sung segment "${s.segmentName}"`).toBe(true);
    }
  });

  it('all vocal segments exist in the input structure', () => {
    const { result, structure } = generate('alignment-check');
    const structureNames = new Set(structure.map((s) => s.name));
    for (const v of result.segments) {
      expect(structureNames.has(v.segmentName)).toBe(true);
    }
  });

  it('every vocal note carries fullWord + a non-empty vocaloidPhonemes list', () => {
    const { result } = generate('lyrics-check');
    let noteCount = 0;
    forEachEvent(result, (ev) => {
      noteCount++;
      expect(ev.type).toBe('vocalNote');
      if (ev.type === 'vocalNote') {
        expect(ev.fullWord).toBeDefined();
        expect(ev.fullWord!.length).toBeGreaterThan(0);
        expect(ev.vocaloidPhonemes).toBeDefined();
        expect(ev.vocaloidPhonemes!.length).toBeGreaterThan(0);
        for (const p of ev.vocaloidPhonemes!) expect(p.length).toBeGreaterThan(0);
      }
    });
    expect(noteCount).toBeGreaterThan(0);
  });

  it('every vocal note has a valid NoteRef (MIDI integer in the slice)', () => {
    const { result } = generate('noteref-check');
    forEachEvent(result, (ev) => {
      if (ev.type === 'vocalNote') {
        expect(NoteRefSchema.safeParse(ev.note).success).toBe(true);
      }
    });
  });

  it('every MIDI note lands in the legacy MelodyClass range envelope [MIN_NOTE..MAX_NOTE]', () => {
    // Step 17a: range envelope from MelodyClass.minNote=43 (G3) / maxNote=59 (B4).
    const { result } = generate('range-check');
    forEachEvent(result, (ev) => {
      if (ev.type === 'vocalNote' && typeof ev.note === 'number') {
        expect(ev.note).toBeGreaterThanOrEqual(MIN_NOTE);
        expect(ev.note).toBeLessThanOrEqual(MAX_NOTE);
      }
    });
  });

  it('adjacent vocal notes differ by ≤ 9 semitones (legacy _isNoteValid invariant)', () => {
    // Step 17a: contour search keeps consecutive pitches within a 9-semitone step.
    const { result } = generate('contour-check');
    for (const segment of result.segments) {
      const sequence: number[] = [];
      for (const bar of segment.bars) {
        const keys = Object.keys(bar.notes).sort();
        for (const key of keys) {
          for (const ev of bar.notes[key]!) {
            if (ev.type === 'vocalNote' && typeof ev.note === 'number') sequence.push(ev.note);
          }
        }
      }
      for (let i = 1; i < sequence.length; i++) {
        const delta = Math.abs(sequence[i]! - sequence[i - 1]!);
        expect(
          delta,
          `segment ${segment.segmentName}: adjacent step ${sequence[i - 1]}→${sequence[i]} (Δ${delta}) exceeds 9`,
        ).toBeLessThanOrEqual(9);
      }
    }
  });

  it('no BarBeat key is >= beatsPerBar()', () => {
    const { result } = generate('bar-range-check');
    const beats = beatsPerBar();
    forEachEvent(result, (_, __, key) => {
      const b = parseBarBeat(key);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(beats);
    });
  });

  it('per-segment vocal bar counts match the structure segment bar counts', () => {
    const { result, structure } = generate('bar-count-check');
    const expectedByName = new Map(structure.map((s) => [s.name, s.bars.length]));
    for (const segment of result.segments) {
      expect(segment.bars.length).toBe(expectedByName.get(segment.segmentName));
    }
  });

  it('marks endOfPhrase coherently: at least one phrase boundary per sung segment + on its final event', () => {
    // Step 17b: per-bar beats come from the rhythmic precedent, so the
    // chorus1 = (bar3.beat2, bar7.beat2) pin from 17a no longer applies.
    // The replacement invariant is the property the lyric layer always
    // preserves: every sung segment ends on an endOfPhrase event, and
    // every sung segment carries at least one endOfPhrase marker (i.e.
    // the lyric cycle's "last word" boundary fires at least once).
    const { result } = generate('phrase-end-check');
    expect(result.segments.length).toBeGreaterThan(0);
    for (const segment of result.segments) {
      let total = 0;
      let endMarkers = 0;
      let lastEventIsEnd = false;
      for (const bar of segment.bars) {
        const keys = Object.keys(bar.notes).sort((a, b) => parseFloat(a) - parseFloat(b));
        for (const key of keys) {
          for (const ev of bar.notes[key]!) {
            total++;
            const isEnd = ev.type === 'vocalNote' && ev.endOfPhrase === true;
            lastEventIsEnd = isEnd;
            if (isEnd) endMarkers++;
          }
        }
      }
      if (total > 0) {
        expect(endMarkers, `${segment.segmentName} has no endOfPhrase markers`).toBeGreaterThan(0);
        expect(lastEventIsEnd, `${segment.segmentName} last event not endOfPhrase`).toBe(true);
      }
    }
  });

  it('beat keys come from the merged precedent grid, not the fixed 0/2 scaffold', () => {
    // Step 17b: rhythmic precedents drive variable density (eighths, dotted
    // quarters, ties). At least one bar across the song must carry a beat
    // OTHER than {0.0, 2.0} — the fixed half-bar scaffold from 17a.
    const { result } = generate('density-check');
    const seenKeys = new Set<string>();
    for (const segment of result.segments) {
      for (const bar of segment.bars) {
        for (const key of Object.keys(bar.notes)) seenKeys.add(key);
      }
    }
    expect(seenKeys.size).toBeGreaterThan(0);
    const offGridKeys = [...seenKeys].filter((k) => k !== '0.0' && k !== '2.0');
    expect(
      offGridKeys.length,
      `expected at least one non-{0.0,2.0} beat from precedent grid, saw only ${[...seenKeys].join(',')}`,
    ).toBeGreaterThan(0);
  });

  it('is reproducible: same seed twice → byte-identical canonical JSON', () => {
    const a = stableStringify(generate('repro').result, 2);
    const b = stableStringify(generate('repro').result, 2);
    expect(a).toBe(b);
  });

  it('different seeds → different vocals (post-step-4 structure variation cascades)', () => {
    const a = stableStringify(generate('seed-one').result, 2);
    const b = stableStringify(generate('seed-two').result, 2);
    expect(a).not.toBe(b);
  });

  it('does not mutate the input structure', () => {
    const ctx = makeCtx('immutability');
    const structure = generateChords(ctx, generateSongStructure(ctx));
    const before = stableStringify(structure, 2);
    generateVocalMelody(ctx, structure);
    expect(stableStringify(structure, 2)).toBe(before);
  });

  it('rejects an unsupported genre', () => {
    // Step 17b: the precedent dispatcher knows all 8 canonical brain
    // genres (ballad / brightPop / edm / latin / organicVibes / rock /
    // schlager / urban). The gate fires for non-canonical strings like
    // the Phase-3 placeholder `pop`.
    const brightPopCtx = makeCtx('genre-check', 'C', 'brightPop');
    const structure = generateChords(brightPopCtx, generateSongStructure(brightPopCtx));
    const popCtx = makeCtx('genre-check', 'C', 'pop');
    expect(() => generateVocalMelody(popCtx, structure)).toThrow(/unsupported genre/u);
  });

  it('matches committed golden fixture (brightPop / brightPop-vertical-slice)', async () => {
    const seed = 'brightPop-vertical-slice';
    const generated = `${stableStringify(generate(seed).result, 2)}\n`;
    const golden = await readFile(vocalsGoldenPath('brightPop', seed), 'utf8');
    expect(generated).toBe(golden);
  });

  // ─── Step 17c — syllable-aware lyric attach ───────────────────────────

  it('emits multi-syllable words: at least one trailing-"-" syllable token in the song', () => {
    // Step 17c: words like "walking" / "golden" / "tonight" syllabify to
    // 2+ syllable tokens; the non-final syllable carries a trailing "-".
    // Pre-17c brightPop fixture was all-monosyllabic so no "-" tokens
    // appeared — this test pins that we are no longer doing that.
    const { result } = generate('multisyllable-check');
    let dashCount = 0;
    forEachEvent(result, (ev) => {
      if (ev.type === 'vocalNote' && ev.fullWord && ev.fullWord.endsWith('-')) {
        dashCount++;
      }
    });
    expect(dashCount).toBeGreaterThan(0);
  });

  it('seed-phrase picks vary across seeds (chorus first-syllable differs for at least one seed pair)', () => {
    // Per-line rng.pick from the genre×segmentType phrase pool means
    // different seeds land on different phrase choices, surfacing as
    // different first-syllable fullWord tokens on the first chorus
    // segment. Run a handful of seeds and assert we see more than one
    // distinct first-token across the song's chorus segments.
    const seeds = ['seed-a', 'seed-b', 'seed-c', 'seed-d', 'seed-e'];
    const firstTokens = new Set<string>();
    for (const seed of seeds) {
      const { result } = generate(seed);
      const chorus = result.segments.find((s) => s.segmentName.startsWith('chorus'));
      if (!chorus) continue;
      for (const bar of chorus.bars) {
        const keys = Object.keys(bar.notes).sort((a, b) => parseFloat(a) - parseFloat(b));
        if (keys.length === 0) continue;
        const events = bar.notes[keys[0]!]!;
        const ev = events[0];
        if (ev && ev.type === 'vocalNote' && ev.fullWord) {
          firstTokens.add(ev.fullWord);
          break;
        }
      }
    }
    expect(firstTokens.size, `expected more than one chorus first-token across ${seeds.length} seeds, saw ${[...firstTokens].join('|')}`).toBeGreaterThan(1);
  });

  it('endOfPhrase fires on the LAST note of every bar that has notes (legacy invariant)', () => {
    // Step 17c scaffolding port: lyricist.js:225 marks endOfPhrase on the
    // last note of every bar via `vocalPatternNoteKeyIndex >= vocalPatternNoteKeys.length - 1`.
    const { result } = generate('eop-bar-check');
    for (const segment of result.segments) {
      for (let i = 0; i < segment.bars.length; i++) {
        const bar = segment.bars[i]!;
        const keys = Object.keys(bar.notes).sort((a, b) => parseFloat(a) - parseFloat(b));
        if (keys.length === 0) continue;
        const lastKey = keys[keys.length - 1]!;
        const events = bar.notes[lastKey]!;
        const lastEvent = events[events.length - 1]!;
        if (lastEvent.type === 'vocalNote') {
          expect(
            lastEvent.endOfPhrase,
            `${segment.segmentName} bar ${i} last event (beat ${lastKey}) missing endOfPhrase`,
          ).toBe(true);
        }
      }
    }
  });
});
