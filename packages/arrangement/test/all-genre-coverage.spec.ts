// docs/56c — All-canonical-genre coverage smoke.
//
// One compact spec that exercises every entry in GenreSchema through
// `orchestrate(...)` and asserts the contracts the per-genre vertical
// slices (brightPop 56a / edm 56b) pinned for their seeds, applied
// uniformly:
//
//   1. orchestrate succeeds — no thrown unsupported-genre errors.
//   2. parseSong (Zod) succeeds.
//   3. semanticValidateSong reports no errors AND no warnings — the
//      per-segment instruments map must align with
//      instrumentDefinitions (the 56b dropped-role fix pin).
//   4. Same (genre, seed) twice → byte-identical canonical Song.
//   5. Different genres at the SAME seed → distinct canonical Song
//      (no accidental aliasing through a shared dispatcher).
//   6. No selection pick has mainStyle === 'pop' (pop alias guard —
//      'pop' is the legacy slice placeholder and was replaced by
//      'brightPop' in 53o; the catalog should NOT ship any pop-tagged
//      rows but if it ever does, brightPop is the only genre allowed
//      to consume them, not a silent fallback for any other genre).
//   7. Every emitted InstrumentDefinition's family was actually
//      tagged with the song's genre at the catalog level — no silent
//      fallback to a brighter-pop row.
//
// DEFAULT_BPM_BY_GENRE is the single source of truth for the
// per-genre default bpm choice.

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BPM_BY_GENRE,
  GenreSchema,
  canonicalStringifySong,
  safeParseSong,
  validateSemantics,
} from '@casperaki/song-schema';

import { createRng } from '@casperaki/music-theory';

import {
  arrangeParts,
  generateChords,
  generateSongStructure,
  orchestrate,
  writeVocals,
  selectInstruments,
  type GenerateParams,
} from '../src/index.js';
import { loadValidatedCatalog } from '../src/catalog/validated-catalog.js';

const GENRES = GenreSchema.options as readonly string[];

function paramsFor(genre: string): GenerateParams {
  return {
    genre,
    key: 'C',
    bpm: DEFAULT_BPM_BY_GENRE[genre as keyof typeof DEFAULT_BPM_BY_GENRE],
    seed: `${genre}-coverage-smoke`,
  };
}

describe('all-canonical-genre orchestrate coverage (docs/56c)', () => {
  it('DEFAULT_BPM_BY_GENRE covers every GenreSchema option', () => {
    for (const g of GENRES) {
      expect(DEFAULT_BPM_BY_GENRE[g as keyof typeof DEFAULT_BPM_BY_GENRE], `missing default bpm for "${g}"`).toBeGreaterThan(0);
    }
  });

  for (const genre of GENRES) {
    describe(genre, () => {
      it('orchestrate succeeds (no unsupported-genre throw)', () => {
        expect(() => orchestrate(paramsFor(genre))).not.toThrow();
      });

      it('parseSong (Zod) succeeds', () => {
        const song = orchestrate(paramsFor(genre));
        const parsed = safeParseSong(song);
        expect(parsed.ok, parsed.ok ? '' : parsed.error.message).toBe(true);
      });

      it('semantic validation produces no errors and no warnings', () => {
        const song = orchestrate(paramsFor(genre));
        const report = validateSemantics(song);
        expect(report.errors, JSON.stringify(report.errors)).toEqual([]);
        expect(report.warnings, JSON.stringify(report.warnings)).toEqual([]);
      });

      it('same seed → byte-identical canonical Song', () => {
        const a = canonicalStringifySong(orchestrate(paramsFor(genre)), 2);
        const b = canonicalStringifySong(orchestrate(paramsFor(genre)), 2);
        expect(a).toBe(b);
      });
    });
  }

  it('different genres at the SAME seed produce DISTINCT canonical Songs', () => {
    // Pin: a future shared-dispatcher mistake (e.g. routing every
    // genre's pattern picks through brightPop) would collapse these
    // to identical bytes. We force the same seed across all genres
    // so the only differing input is `genre`.
    const SHARED_SEED = 'all-genre-distinctness-check';
    const sigs = new Map<string, string>();
    for (const g of GENRES) {
      const params: GenerateParams = {
        genre: g,
        key: 'C',
        bpm: DEFAULT_BPM_BY_GENRE[g as keyof typeof DEFAULT_BPM_BY_GENRE],
        seed: SHARED_SEED,
      };
      const song = orchestrate(params);
      const sig = canonicalStringifySong(song, 2);
      // No two genres should produce byte-identical Songs at the
      // same seed.
      for (const [other, otherSig] of sigs) {
        expect(
          sig,
          `"${g}" and "${other}" produced byte-identical canonical Songs at seed="${SHARED_SEED}"`,
        ).not.toBe(otherSig);
      }
      sigs.set(g, sig);
    }
    expect(sigs.size).toBe(GENRES.length);
  });

  it('no instrument pick has mainStyle === "pop" — pop alias guard', () => {
    // docs/53o decommissioned `pop` as a brain genre in favour of
    // `brightPop`. The catalog shouldn't carry mainStyle:'pop' rows
    // after 53q rebuild; this test pins the contract: every emitted
    // InstrumentDefinition's catalog row has mainStyle !== 'pop'.
    const catalog = loadValidatedCatalog();
    for (const genre of GENRES) {
      const song = orchestrate(paramsFor(genre));
      for (const def of song.instrumentDefinitions) {
        const entry = catalog.byId.get(def.id);
        if (!entry) continue; // Vocal placeholder + Loop sometimes have synthetic ids
        expect(
          entry.mainStyle,
          `genre=${genre} picked an instrumentDefinition whose catalog row has mainStyle='pop' (${def.id})`,
        ).not.toBe('pop');
      }
    }
  });

  it('every tonal pick is either genre-tagged OR an EXPLICITLY tracked fallback — no silent fallback', () => {
    // Pin: no tonal role's pick survives the candidatesFor filter
    // via a family that doesn't actually match the genre's
    // `mainStyle` or `addStyles` UNLESS the picked SelectedInstrument
    // also records `pickSource: 'fallback'` (the explicit
    // any-genre fallback the 56c follow-on added for drums + bass
    // mirroring legacy `ArrangementsClass.js:432-440`'s behaviour
    // of reading Drums/Bass from a pre-authored pattern bundle
    // without genre-tag filtering them).
    //
    // A bug where someone widens the pool without checking the
    // style tag now still fails because the pickSource would stay
    // 'genre' while the actual entry tag doesn't match.
    //
    // Loop is EXCLUDED from this check: docs/54r selectLoop has a
    // documented fallback path that picks an any-genre loop row when
    // the genre has zero loop candidates at the requested bpm.
    // Vocal placeholders also fall through (synthetic ids not in
    // the validated catalog).
    const catalog = loadValidatedCatalog();
    for (const genre of GENRES) {
      const song = orchestrate(paramsFor(genre));
      // Build a map id → pickSource from the deterministic selection
      // result so we can distinguish silent vs explicit fallbacks.
      // The final selection orchestrate lowers (partner tracks for thin sections included).
      const ctx = { rng: createRng(paramsFor(genre).seed), params: paramsFor(genre) };
      const { structure } = writeVocals(ctx, generateChords(ctx, generateSongStructure(ctx)));
      const sel = arrangeParts(ctx, structure).selection;
      const pickSourceById = new Map<string, 'genre' | 'fallback'>();
      for (const s of sel.instruments) {
        pickSourceById.set(s.entry.id, s.pickSource);
      }

      for (const def of song.instrumentDefinitions) {
        const entry = catalog.byId.get(def.id);
        if (!entry) continue;
        if (entry.family === 'percussionLoops') continue; // documented fallback
        const matched =
          entry.mainStyle === genre ||
          (entry.addStyles as readonly string[]).includes(genre);
        if (matched) continue;
        // Not genre-tagged → MUST be an explicit fallback.
        const pickSource = pickSourceById.get(def.id);
        expect(
          pickSource,
          `genre=${genre} picked "${def.name}" (${def.id}, family=${entry.family}) ` +
            `whose mainStyle="${entry.mainStyle}" and addStyles=[${entry.addStyles.join(',')}] — ` +
            `not tagged with the song genre AND pickSource is missing. Silent fallback.`,
        ).toBe('fallback');
      }
    }
  });
});
