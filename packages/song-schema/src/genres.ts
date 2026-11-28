// Genres as users see them, and genre recipes (docs/superpowers/specs/2026-11-28-genre-recipes-design.md): a derived
// genre is one entry here, a base genre and only what differs. The generator runs it as its base (banks, catalogue
// tags, mix tables and the engine know only the base genres, GenreSchema); the song keeps the derived key, and three
// hooks read the recipe: the drum samples (drums/kit.ts), the drum styles per section type (patterns/drums.ts) and the
// tracks that always play (selection). Adding a genre like this is adding an entry.

import { z } from 'zod';

import { GENRE_TEMPO_RANGES, GenreSchema, registerDerivedGenre, type Genre, type GenreTempoRange } from './schemas/common.js';
import type { MixOverrides } from './schemas/mix-overrides.js';

/** Lanes a recipe can make play in every section (selection/index.ts maps them to its lane specs). */
export const ALWAYS_PLAYING_LANES = ['electricGuitarClean', 'synthsPlucked'] as const;
export type AlwaysPlayingLane = (typeof ALWAYS_PLAYING_LANES)[number];

/** Which Virtual Guitarist patterns a recipe's guitar plays. */
export type GuitarPatternChoice = { readonly families: readonly string[] } | { readonly strummed: true };

export interface GenreRecipe {
  /** What users see. */
  readonly label: string;
  /** One line for the genre tiles. */
  readonly blurb: string;
  /** The genre it is generated as. */
  readonly base: Genre;
  /** Drum sounds of these catalogue families come from one sample library (the catalogue's `library` field). */
  readonly drumLibrary?: { readonly library: string; readonly families: readonly string[] };
  /** Drum styles (drums bank-index.json style names) per section type, instead of the base genre's. */
  readonly drumStyles: Readonly<Record<string, readonly string[]>>;
  /** Lanes that play in every section. */
  readonly alwaysPlays: readonly AlwaysPlayingLane[];
  /** The guitar's patterns: Virtual Guitarist pattern families of these names ("Funk" → "…-Funk-03"), or strummed
   *  patterns only (recorded strums, no single-string picking; arrangement virtual-guitarist-bank.ts). */
  readonly guitarPatterns?: GuitarPatternChoice;
  /** The hi-hats of these section types from this drum style (laid over the section's own kick, snare and the rest);
   *  other sections keep their own. */
  readonly hiHats?: { readonly style: string; readonly sectionTypes: readonly string[] };
  /** Section types whose parts are fixed: these tracks (drums, bass, or lanes the recipe always plays) and, with
   *  plusOne, one more of the song's other tracks (drawn once per song; never another always-playing lane). */
  readonly sectionParts?: Readonly<Record<string, { readonly keep: readonly ('drums' | 'bass' | AlwaysPlayingLane)[]; readonly plusOne: boolean }>>;
  /** Section types that play more tracks than another (chorus: 'verse'): their own rotating draw, topped up with the
   *  song's other tracks when it comes out no bigger. */
  readonly busierThan?: Readonly<Record<string, string>>;
  /** The track mastering matches the song to instead of Atemlos: the name of its data file (the brain's
   *  mastering references directory, `<name>.json`, made by casperaki_master_reference). */
  readonly masteringReference?: string;
  /** The mix a new song of the genre starts with (its Pro-mode mix: lane trims by track name, kept only for the
   *  tracks the song has; bus plugin settings). */
  readonly mix?: MixOverrides;
}

export const GENRE_RECIPES = {
  // Owner 2026-11-28: "like bright pop but only with Dr. Luke drums and an electric guitar on every track and hip-hop
  // drum patterns in the verse. Otherwise like brightPop."
  casperakiPop: {
    label: 'Casperaki Pop',
    blurb: 'Bright pop with hard-hitting drums, funky guitar and hip-hop verses',
    base: 'brightPop',
    drumLibrary: { library: 'drLuke', families: ['kickDrums', 'snareDrums', 'clapsSnaps'] },
    drumStyles: {
      verse: ['urban', 'authored-urban-boom-bap', 'authored-urban-trap-hats', 'authored-gmd-urban-boom-bap', 'authored-gmd-urban-soul-funk-pocket'],
    },
    // Owner 2026-11-28: "make sure the casperaki pop always gets guitar and a bouncy synth" (the plucked synth).
    alwaysPlays: ['electricGuitarClean', 'synthsPlucked'],
    // Owner 2026-11-28: "make sure the guitar is syncopated", then "I wasn't able to get proper strummed guitars": the
    // Funk and R&B families were a strum a bar and single-string picking, so strummed patterns only (both banks).
    guitarPatterns: { strummed: true },
    // The hip-hop generator's hats (8ths with 16th doubles and rolls; owner 2026-11-28: the trap hi-hat is "not always
    // on every sixteenth note - we have it in hip hop"), not the authored trap-hats line of straight 16ths.
    // Verses only (owner 2026-11-28: "we can't have it in all segments"); the other sections keep Bright Pop's hats.
    hiHats: { style: 'urban', sectionTypes: ['verse'] },
    // Owner 2026-11-28: Dr. Luke drums "hit much harder". Of four A/B masters (standard or harder drums, Atemlos or "Your
    // Love Is My Drug" as the mastering reference) he chose harder drums mastered towards "Your Love Is My Drug"
    // ("let's go for harder ylimd for Casperaki pop"). The mix: the drums +4 dB, the pad and synths -2 dB, keys -1 dB, the
    // kick bus's Thunder 0.41 -> 0.65 and its output 0.53 -> 0.62, the drum bus's Pyewacket input 0.83 -> 1.0 and its
    // output 0.5 -> 0.6 (slots of casperaki_engine/config/mix-config.json's rack chains).
    // Owner 2026-11-28: "more instrument variety between verse and chorus" -> lean verse (drums, bass, the guitar and
    // one more part), and a chorus with more parts than the verse, rotating as the patterns do ("as long as we have
    // more in the chorus than in the verse").
    sectionParts: { verse: { keep: ['drums', 'bass', 'electricGuitarClean'], plusOne: true } },
    busierThan: { chorus: 'verse' },
    masteringReference: 'your-love-is-my-drug',
    mix: {
      lanes: { Drums: { volumeDb: 4 }, Pad: { volumeDb: -2 }, Synths: { volumeDb: -2 }, PluckedSynths: { volumeDb: -2 }, Keys: { volumeDb: -1 } },
      buses: { kicks: { '1': [0.65, 1], '3': [0.62] }, drums: { '1': [1, 0.499824703, 0.455113977], '3': [0.6] } },
    },
  },
} as const satisfies Record<string, GenreRecipe>;

export type RecipeGenre = keyof typeof GENRE_RECIPES;

for (const [genre, recipe] of Object.entries(GENRE_RECIPES) as [RecipeGenre, GenreRecipe][]) registerDerivedGenre(genre, recipe.base);

/** Every genre a song can have: the base genres, then the recipes. */
export const SongGenreSchema = z.enum([...GenreSchema.options, ...(Object.keys(GENRE_RECIPES) as RecipeGenre[])] as [Genre | RecipeGenre, ...(Genre | RecipeGenre)[]]);
export type SongGenre = z.infer<typeof SongGenreSchema>;

/** The recipe of a derived genre, or undefined for a base genre. Throws for an unknown genre. */
export function genreRecipe(genre: string): GenreRecipe | undefined {
  if (Object.prototype.hasOwnProperty.call(GENRE_RECIPES, genre)) return GENRE_RECIPES[genre as RecipeGenre];
  if (GenreSchema.safeParse(genre).success) return undefined;
  throw new Error(`unknown genre "${genre}" (genres: ${SongGenreSchema.options.join(', ')})`);
}

/** The base genre a genre is generated as (itself for a base genre). Throws for an unknown genre. */
export function baseGenre(genre: string): Genre {
  return genreRecipe(genre)?.base ?? (genre as Genre);
}

const BASE_LABELS: Readonly<Record<Genre, string>> = {
  ballad: 'Ballad',
  brightPop: 'Bright pop',
  // Owner 2026-11-28: "let's rename EDM globally to Dance" (the key stays edm: catalogue tags, banks, saved songs).
  edm: 'Dance',
  latin: 'Latin',
  organicVibes: 'Organic',
  rock: 'Rock',
  schlager: 'Schlager',
  urban: 'Urban',
};

const BASE_BLURBS: Readonly<Record<Genre, string>> = {
  ballad: 'Slow, warm, piano and strings',
  brightPop: 'Upbeat radio pop',
  edm: 'Club drops and synth leads',
  latin: 'Syncopated grooves and guitars',
  organicVibes: 'Acoustic, relaxed, natural',
  rock: 'Guitars, live drums, energy',
  schlager: 'Sing-along four-to-the-floor',
  urban: 'Hip-hop and R&B beats',
};

const recipeField = (k: 'label' | 'blurb'): Record<RecipeGenre, string> =>
  Object.fromEntries((Object.entries(GENRE_RECIPES) as [RecipeGenre, GenreRecipe][]).map(([g, r]) => [g, r[k]])) as Record<RecipeGenre, string>;

/** What users see for each genre. */
export const GENRE_LABELS: Readonly<Record<SongGenre, string>> = { ...BASE_LABELS, ...recipeField('label') };
/** One-line description for the genre tiles. */
export const GENRE_BLURBS: Readonly<Record<SongGenre, string>> = { ...BASE_BLURBS, ...recipeField('blurb') };

/** The label of a genre; throws for one this build does not know (so it shows up, not as a raw id). */
export function genreLabel(genre: string): string {
  const label = (GENRE_LABELS as Record<string, string>)[genre];
  if (label === undefined) throw new Error(`unknown genre "${genre}" (genres: ${SongGenreSchema.options.join(', ')})`);
  return label;
}

/** The tempo range of a genre (a recipe's is its base genre's). */
export function genreTempoRange(genre: string): GenreTempoRange {
  return GENRE_TEMPO_RANGES[baseGenre(genre)];
}
