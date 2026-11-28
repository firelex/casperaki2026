// Step 5 — instrument selection (docs/58i lane-oriented rewrite).
//
// Faithful port of the LEGACY two-phase probabilistic selection model
// (memory: "Phase-58: port legacy, no A/B"):
//
//   1. ROSTER ROLL — `rollRoster` ports `casperaki1/.../controllers/
//      patterns.js getPattern`. Per genre it rolls a probabilistic
//      *combination* of instrument lanes (`furtherInstruments[]`). Drums +
//      Bass + a pad are always present; the genre `switch` then rolls a
//      nested decision tree (e.g. ballad: guitar/piano/guitarPiano;
//      edm/schlager: focusOnPiano/focusOnSynths/focusOnBass → nested
//      decision2). The legacy `decision1 = '…'` hard-overrides that
//      discarded the first roll are treated as debug artifacts — we restore
//      the underlying weighted rolls so the full designed tree fires.
//
//   2. PER-SEGMENT ACTIVATION — `activateSegment` ports
//      `casperaki1/.../arrangements/ArrangementsClass.js:578-739`. Computed
//      once per segment TYPE (so chorus1 === chorus2). Chorus uses the whole
//      base roster; every other type keeps the essentials (Drums + Bass +
//      pad), uses `rng.int(0, N-1)` of the N non-essential lanes (dropping
//      the rest) and — if ≥1 was dropped — adds ONE extra lane from a genre
//      permitted-set (legacy `_addInstrument`; edm/schlager also add a
//      plucked synth). Added lanes join the roster but activate only where
//      used.
//
// DETERMINISM — every legacy `Math.random` / `Tools.selectRandomly` /
// `Tools.tossCoin` becomes a seeded `Rng` draw (`ctx.rng.fork(...)`),
// mirroring the drums port (`patterns/drums-algo.ts`).
//
// LANE MODEL — the roster is an ordered list of {@link SelectedInstrument}
// lanes, each with a unique display name. A family may carry more than one
// lane (e.g. rock's two electric guitars → `Guitar` + `Guitar 2`).
// `InstrumentFamily` is the catalog-family classifier (pattern dispatch +
// engine routing), NOT a uniqueness key.
//
// brightPop ⇐ legacy popTight, organicVibes ⇐ legacy popLoose (the workbook
// rename — `casperaki1/googleApi/updateSoundDatabase.js:77`).
//
// The input structure is read-only; we project from it rather than mutate.

import type { AlwaysPlayingLane, SongStructure } from '@casperaki/song-schema';

import type { Rng } from '@casperaki/music-theory';
import type { GeneratorContext } from '../context.js';
import { authoredStylesFor } from '../patterns/authored-bank.js';
import {
  loadValidatedCatalog,
  type ValidatedCatalogEntry,
} from '../catalog/validated-catalog.js';
import type { InstrumentSheetFamily, MainStyle, AddStyle } from '../catalog/types.js';
import {
  type InstrumentFamily,
  type SegmentActivity,
  type SelectedInstrument,
  type SelectedLoop,
  type SelectionResult,
} from './types.js';

// ---------------------------------------------------------------------------
// Lane display-name bases. The orchestrator + engine adapter key on these
// (must stay in sync with orchestrate `DISPLAY_NAME_FOR_ROLE` + adapter
// `*_DISPLAY_NAME`). A family with >1 lane suffixes ` 2`, ` 3` (see
// `RosterBuilder.add`).
// ---------------------------------------------------------------------------
const LANE_BASE_NAME: Readonly<Record<InstrumentFamily, string>> = {
  drums: 'Drums',
  bass: 'Bass',
  keys: 'Keys',
  pad: 'Pad',
  guitar: 'Guitar',
  synths: 'Synths',
  pluckedSynths: 'PluckedSynths',
  popStrings: 'PopStrings',
  popBrass: 'PopBrass',
};

// Legacy `ArrangementsClass.js:508-523 + 681-708` — the genres that activate
// a percussion loop on verse segments. (Loop is an orthogonal sample lane
// handled by `selectLoop` + the per-segment `loopActive` flag, not part of
// the tonal roster.)
const LOOP_GENRES: ReadonlySet<string> = new Set([
  'ballad',
  'brightPop',
  'edm',
  'latin',
  'organicVibes',
  'schlager',
  'urban',
]);

// Display name for the loop track (legacy routed by `instrument->name`).
const LOOP_DISPLAY_NAME = 'Loop';

const SUPPORTED_GENRES: ReadonlySet<string> = new Set([
  'ballad', 'brightPop', 'edm', 'latin', 'organicVibes', 'rock', 'schlager', 'urban',
]);

// docs/58i — orchestral (popStrings / popBrass) pattern coverage. Selection
// only emits those lanes for the genres whose pattern banks actually map a
// style (`data/patterns/{strings,brass}/bank-index.json#genreStyles`): brass =
// schlager / latin / organicVibes (docs/62 A5 — casperaki2 plays brass in
// all three via the genre-independent StefanSchlagerPatterns bank); strings =
// ballad / edm / schlager / organicVibes / urban (the real stringPatterns.json
// buckets — to-do #3). A rolled/added orchestral lane for an
// unsupported genre is skipped (the union stays additive, so widening the bank
// lights the lane up with no selection change). Families absent from this
// table have full genre coverage.
const ORCHESTRAL_GENRE_SUPPORT: Readonly<Partial<Record<InstrumentFamily, ReadonlySet<string>>>> = {
  // strings: the real stringPatterns.json covers ballad / edm / organicVibes
  // buckets; legacy dispatch maps edm+schlager -> edm and urban -> organicVibes
  // (data/patterns/strings/bank-index.json#genreStyles).
  popStrings: new Set(['ballad', 'edm', 'schlager', 'organicVibes', 'urban']),
  // docs/62 A5: casperaki2 (canonical) rosters+plays brass in latin and
  // organicVibes too — its LibraryBrass loads the genre-independent
  // StefanSchlagerPatterns bank for those genres (config brassPatterns
  // latin/organicVibes → library*/libraryStabs). The brass bank-index now
  // maps latin/organicVibes → the existing `schlager` style, so widening the
  // gate lights up the BRASS lanes that rollLatin/rollPopLoose already push.
  // (c1 was schlager-only; we follow c2.)
  popBrass: new Set(['schlager', 'latin', 'organicVibes']),
};

function laneSupportedForGenre(familyClass: InstrumentFamily, genre: string): boolean {
  const set = ORCHESTRAL_GENRE_SUPPORT[familyClass];
  return set === undefined || set.has(genre);
}

/**
 * Families a user may add (Add track, Change sound) and the pattern lab may
 * preview in every genre, although the generator only rolls them in the
 * genres above. Brass: the library's horns suit every style; generated songs
 * keep brass to schlager / latin / organicVibes until more styles have brass
 * patterns of their own (docs/68).
 */
const USER_ANY_GENRE: ReadonlySet<InstrumentFamily> = new Set(['popBrass']);

// ---------------------------------------------------------------------------
// Lane catalog-resolution config (the original ROLE_CONFIG, generalized to a
// per-lane spec). `familyClass` is the lane's InstrumentFamily classifier;
// `cfg` is the catalog filter used by `candidatesFor`.
// ---------------------------------------------------------------------------
interface RoleConfig {
  /** Single catalog family. */
  readonly family?: InstrumentSheetFamily;
  /** Multi-family pool (docs/54u — guitar spans acoustic + electric). */
  readonly families?: readonly InstrumentSheetFamily[];
  /** Restrict candidates to entries whose lowLevel is in this set. */
  readonly lowLevels?: readonly string[];
  /** Restrict candidates to entries whose `preset` EQUALS one of these. */
  readonly presetEquals?: readonly string[];
  /** When the genre-tagged pool is empty, fall back to the any-genre pool at
   *  the same family/lowLevel/preset filter (the LEGACY default — tonal
   *  samples were picked from the full pool, only PREFERRING genre-tagged
   *  rows; `ArrangementsClass.js:64-198`). Defaults to ENABLED; set `false`
   *  to force the strict drop-if-empty behaviour. */
  readonly fallbackToAnyGenre?: boolean;
}

interface LaneSpec {
  /** Lane classifier → display-name base + pattern dispatch. */
  readonly familyClass: InstrumentFamily;
  /** Legacy lowLevelType token (diagnostics only). */
  readonly token: string;
  readonly cfg: RoleConfig;
}

// Guitar stereo "Default Notes" rows (chromatic renders guitarNotes.json can
// slice) — split clean vs distorted electric for the legacy clean/distorted
// tokens (Domino/LpChorus ≈ clean, StratDrive/WarmCrunch ≈ driven).
const ACOUSTIC_GUITAR_LOWLEVELS = [
  'acousticGuitarsNylonStereo',
  'acousticGuitarsSteelStereo',
] as const;
const ELECTRIC_CLEAN_LOWLEVELS = [
  'electricGuitarsDominoStereo',
  'electricGuitarsLpChorusStereo',
] as const;
const ELECTRIC_DIST_LOWLEVELS = [
  'electricGuitarsStratDriveStereo',
  'electricGuitarsWarmCrunchStereo',
] as const;

// --- Lane specs (legacy lowLevelType token → catalog filter) ---------------
const DRUMS_SPEC: LaneSpec = {
  familyClass: 'drums',
  token: 'kickDrums',
  cfg: { family: 'kickDrums', fallbackToAnyGenre: true },
};
const BASS_SPEC: LaneSpec = {
  familyClass: 'bass',
  token: 'basses',
  cfg: { family: 'basses', fallbackToAnyGenre: true },
};
const SOFT_PAD: LaneSpec = {
  familyClass: 'pad',
  token: 'synthsSoftPad',
  cfg: { family: 'synths', lowLevels: ['synthsSoftPad'] },
};
const BRIGHT_PAD: LaneSpec = {
  familyClass: 'pad',
  token: 'synthsBrightPad',
  cfg: { family: 'synths', lowLevels: ['synthsBrightPad'] },
};
const ACOUSTIC_GUITAR: LaneSpec = {
  familyClass: 'guitar',
  token: 'acousticGuitarsPatternPlayed',
  cfg: {
    families: ['acousticGuitars'],
    lowLevels: ACOUSTIC_GUITAR_LOWLEVELS,
    presetEquals: ['Default Notes'],
  },
};
const ELECTRIC_GUITAR_CLEAN: LaneSpec = {
  familyClass: 'guitar',
  token: 'electricGuitarsPatternPlayedClean',
  cfg: {
    families: ['electricGuitars'],
    lowLevels: ELECTRIC_CLEAN_LOWLEVELS,
    presetEquals: ['Default Notes'],
  },
};
const ELECTRIC_GUITAR_DIST: LaneSpec = {
  familyClass: 'guitar',
  token: 'electricGuitarsPatternPlayedDistorted',
  cfg: {
    families: ['electricGuitars'],
    lowLevels: ELECTRIC_DIST_LOWLEVELS,
    presetEquals: ['Default Notes'],
  },
};
const PIANO_ACOUSTIC: LaneSpec = {
  familyClass: 'keys',
  token: 'keysAcousticPiano',
  cfg: { family: 'keys', lowLevels: ['keysAcousticPiano'] },
};
const PIANO_ELECTRONIC: LaneSpec = {
  familyClass: 'keys',
  token: 'keysElectronicPiano',
  cfg: { family: 'keys', lowLevels: ['keysElectronicPiano'] },
};
const LEAD_SOFT: LaneSpec = {
  familyClass: 'synths',
  token: 'leadSynthsSoft',
  cfg: { family: 'leadSynths', lowLevels: ['leadSynthsSoft'] },
};
const LEAD_BRIGHT: LaneSpec = {
  familyClass: 'synths',
  token: 'leadSynthsBright',
  cfg: { family: 'leadSynths', lowLevels: ['leadSynthsBright'] },
};
const LEAD_ANALOG: LaneSpec = {
  familyClass: 'synths',
  token: 'leadSynthsAnalog',
  cfg: { family: 'leadSynths', lowLevels: ['leadSynthsAnalog'] },
};
const PLUCKED: LaneSpec = {
  familyClass: 'pluckedSynths',
  token: 'synthsPlucked',
  cfg: { family: 'synths', lowLevels: ['synthsPlucked'] },
};
// popStrings → legacy `popStringsGeneric` (the `stabs` string pattern); the
// union catalog split it into High/Low × articulation, we take the Staccato
// (stab) rows. popBrass → legacy `popBrassBrightBrassSection`.
const STRINGS: LaneSpec = {
  familyClass: 'popStrings',
  token: 'popStringsGeneric',
  cfg: {
    family: 'popStrings',
    lowLevels: ['popHighStringsStaccato', 'popLowStringsStaccato'],
    fallbackToAnyGenre: true,
  },
};
const BRASS: LaneSpec = {
  familyClass: 'popBrass',
  token: 'popBrassBrightBrassSection',
  cfg: {
    family: 'popBrass',
    lowLevels: [
      'popBrassBrightBrassSectionLegato',
      'popBrassBrightBrassSectionStaccato',
    ],
    fallbackToAnyGenre: true,
  },
};

// ---------------------------------------------------------------------------
// Per-segment "add one" permitted-sets (legacy `ArrangementsClass.js:683-714`)
// — the lane added back when a non-chorus segment dropped ≥1 non-essential.
// `break` segments use a narrower set (`:658-669`).
// ---------------------------------------------------------------------------
const ADD_ONE_SPECS: Readonly<Record<string, readonly LaneSpec[]>> = {
  ballad: [ACOUSTIC_GUITAR, PIANO_ACOUSTIC],
  edm: [PIANO_ACOUSTIC, LEAD_ANALOG, LEAD_SOFT, BRASS, STRINGS, PLUCKED],
  schlager: [PIANO_ACOUSTIC, LEAD_ANALOG, LEAD_SOFT, BRASS, STRINGS, PLUCKED],
  latin: [ACOUSTIC_GUITAR, ELECTRIC_GUITAR_CLEAN, PIANO_ACOUSTIC, LEAD_SOFT, BRASS, PLUCKED],
  brightPop: [ACOUSTIC_GUITAR, ELECTRIC_GUITAR_CLEAN, PIANO_ACOUSTIC, PIANO_ELECTRONIC, LEAD_ANALOG, LEAD_SOFT],
  organicVibes: [ACOUSTIC_GUITAR, ELECTRIC_GUITAR_CLEAN, PIANO_ACOUSTIC, PIANO_ELECTRONIC, BRASS],
  rock: [ELECTRIC_GUITAR_CLEAN, ELECTRIC_GUITAR_DIST, PIANO_ACOUSTIC],
  urban: [PIANO_ACOUSTIC, PIANO_ELECTRONIC, LEAD_ANALOG, PLUCKED],
};
const BREAK_ADD_ONE_SPECS: Readonly<Record<string, readonly LaneSpec[]>> = {
  ballad: [PIANO_ACOUSTIC],
  // legacy `default` break set
  edm: [PIANO_ACOUSTIC, PIANO_ELECTRONIC, PLUCKED],
  schlager: [PIANO_ACOUSTIC, PIANO_ELECTRONIC, PLUCKED],
  latin: [PIANO_ACOUSTIC, PIANO_ELECTRONIC, PLUCKED],
  brightPop: [PIANO_ACOUSTIC, PIANO_ELECTRONIC, PLUCKED],
  organicVibes: [PIANO_ACOUSTIC, PIANO_ELECTRONIC, PLUCKED],
  rock: [PIANO_ACOUSTIC, PIANO_ELECTRONIC, PLUCKED],
  urban: [PIANO_ACOUSTIC, PIANO_ELECTRONIC, PLUCKED],
};

// ===========================================================================
// Phase 1 — roster roll (port of patterns.js getPattern)
// ===========================================================================

/** Rolled per-song combination, before catalog resolution: the mandatory pad
 *  lane + the genre's non-essential tonal lanes. Drums + Bass are implicit
 *  essentials (added by `buildRoster`). */
/** The lane specs of the lanes a genre recipe can make play in every section. */
const ALWAYS_PLAYING_SPECS: Readonly<Record<AlwaysPlayingLane, LaneSpec>> = {
  electricGuitarClean: ELECTRIC_GUITAR_CLEAN,
  synthsPlucked: PLUCKED,
};

interface RosterRoll {
  readonly padSpec: LaneSpec;
  readonly nonEssential: readonly LaneSpec[];
}

function rollRoster(rng: Rng, genre: string): RosterRoll {
  switch (genre) {
    case 'ballad':
      return rollBallad(rng);
    case 'brightPop':
      return rollPopTight(rng);
    case 'organicVibes':
      return rollPopLoose(rng);
    case 'edm':
    case 'schlager':
      return rollEdmSchlager(rng);
    case 'latin':
      return rollLatin(rng);
    case 'rock':
      return rollRock(rng);
    case 'urban':
      return rollUrban(rng);
    default:
      throw new Error(
        `rollRoster: unsupported genre "${genre}" — supported: ${[...SUPPORTED_GENRES].join(', ')}`,
      );
  }
}

function rollBallad(rng: Rng): RosterRoll {
  const padSpec = rng.pick([SOFT_PAD, BRIGHT_PAD]);
  const nonEssential: LaneSpec[] = [];
  // legacy: selectRandomly(['guitar','piano','piano','guitarPiano','strings'])
  // (patterns.js:480) — the 1-in-5 `strings` branch rosters a pop/orchestral
  // string section.
  switch (rng.pick(['guitar', 'piano', 'piano', 'guitarPiano', 'strings'])) {
    case 'guitar':
      nonEssential.push(ACOUSTIC_GUITAR);
      break;
    case 'piano':
      nonEssential.push(PIANO_ACOUSTIC);
      break;
    case 'guitarPiano':
      nonEssential.push(ACOUSTIC_GUITAR, PIANO_ACOUSTIC);
      break;
    case 'strings':
      nonEssential.push(STRINGS);
      break;
  }
  return { padSpec, nonEssential };
}

// brightPop ⇐ legacy popTight. NB: the legacy 'piano' branch pushes lead
// synths (the keys push is commented out) and intentionally duplicates
// leadSynthsSoft.
function rollPopTight(rng: Rng): RosterRoll {
  const padSpec = BRIGHT_PAD; // legacy fixes synthsBrightPad for popTight
  const nonEssential: LaneSpec[] = [];
  switch (rng.pick(['guitar', 'piano', 'piano', 'guitarPiano'])) {
    case 'guitar':
      // virtualGuitaristAcoustic | virtualGuitaristElectricClean
      nonEssential.push(rng.pick([ACOUSTIC_GUITAR, ELECTRIC_GUITAR_CLEAN]));
      break;
    case 'piano':
      nonEssential.push(rng.pick([LEAD_SOFT, LEAD_BRIGHT]));
      nonEssential.push(LEAD_SOFT);
      nonEssential.push(LEAD_ANALOG);
      break;
    case 'guitarPiano':
      nonEssential.push(rng.pick([ACOUSTIC_GUITAR, ELECTRIC_GUITAR_CLEAN]));
      nonEssential.push(rng.pick([PIANO_ACOUSTIC, PIANO_ACOUSTIC, PIANO_ELECTRONIC]));
      break;
  }
  return { padSpec, nonEssential };
}

// organicVibes ⇐ legacy popLoose.
function rollPopLoose(rng: Rng): RosterRoll {
  const padSpec = rng.pick([SOFT_PAD, BRIGHT_PAD]);
  const nonEssential: LaneSpec[] = [];
  // legacy: every decision1 branch rolls a 1-in-2 pop-high-strings section
  // (patterns.js:866-871,880-885,899-904).
  switch (rng.pick(['guitar', 'piano', 'piano', 'guitarPiano'])) {
    case 'guitar':
      nonEssential.push(rng.pick([ACOUSTIC_GUITAR, ELECTRIC_GUITAR_CLEAN]));
      if (rng.pick([false, true])) nonEssential.push(STRINGS);
      break;
    case 'piano':
      nonEssential.push(rng.pick([PIANO_ACOUSTIC, PIANO_ACOUSTIC, PIANO_ACOUSTIC, PIANO_ELECTRONIC]));
      if (rng.pick([false, true])) nonEssential.push(STRINGS);
      break;
    case 'guitarPiano':
      nonEssential.push(rng.pick([ACOUSTIC_GUITAR, ELECTRIC_GUITAR_CLEAN]));
      nonEssential.push(rng.pick([PIANO_ACOUSTIC, PIANO_ACOUSTIC, PIANO_ELECTRONIC]));
      if (rng.pick([false, true])) nonEssential.push(STRINGS);
      break;
  }
  // legacy: 1-in-5 chance of a brass section.
  if (rng.pick([false, false, false, false, true])) nonEssential.push(BRASS);
  return { padSpec, nonEssential };
}

function rollEdmSchlager(rng: Rng): RosterRoll {
  const padSpec = rng.pick([SOFT_PAD, BRIGHT_PAD]);
  const nonEssential: LaneSpec[] = [];
  // decision1 (legacy hard-override removed — full designed tree)
  switch (rng.pick(['focusOnPiano', 'focusOnSynths', 'focusOnBass'])) {
    case 'focusOnPiano': {
      nonEssential.push(PIANO_ACOUSTIC); // keysAcousticPianoHouse
      switch (rng.pick(['bassSupport', 'synthsSupport'])) {
        case 'bassSupport':
          nonEssential.push(PLUCKED);
          break;
        case 'synthsSupport':
          nonEssential.push(rng.pick([LEAD_SOFT, PLUCKED]));
          break;
      }
      break;
    }
    case 'focusOnSynths':
      nonEssential.push(rng.pick([LEAD_BRIGHT, PLUCKED]));
      // legacy: each synth sub-branch rolls a 1-in-2 accented pop-strings
      // section (patterns.js:592-599,609-616) — same gate for both, so it
      // lifts out of the sub-switch.
      if (rng.pick([false, true])) nonEssential.push(STRINGS);
      // (bass simple/complex — style only, no lane)
      rng.pick(['simpleBass', 'complexBass']);
      break;
    case 'focusOnBass':
      // legacy `focusOnBass` decision2 = selectRandomly(['stringSupport'])
      // — the `brassSupport` case is unreachable dead code, so BOTH edm and
      // schlager always take string support (patterns.js:645-671). (Earlier
      // rebuild used `edm ? STRINGS : BRASS`, which mis-rostered schlager.)
      nonEssential.push(STRINGS);
      break;
  }
  return { padSpec, nonEssential };
}

function rollLatin(rng: Rng): RosterRoll {
  const padSpec = BRIGHT_PAD; // legacy fixes synthsBrightPad
  const nonEssential: LaneSpec[] = [LEAD_SOFT]; // legacy always adds leadSynthsSoft
  switch (
    rng.pick(['guitarBrass', 'piano', 'pianoBrass', 'guitarPiano', 'guitarPianoBrass'])
  ) {
    case 'guitarBrass':
      nonEssential.push(rng.pick([ACOUSTIC_GUITAR, ELECTRIC_GUITAR_CLEAN]), BRASS);
      break;
    case 'piano':
      nonEssential.push(PIANO_ACOUSTIC);
      break;
    case 'pianoBrass':
      nonEssential.push(PIANO_ACOUSTIC, BRASS);
      break;
    case 'guitarPiano':
      nonEssential.push(rng.pick([ACOUSTIC_GUITAR, ELECTRIC_GUITAR_CLEAN]), PIANO_ACOUSTIC);
      break;
    case 'guitarPianoBrass':
      nonEssential.push(rng.pick([ACOUSTIC_GUITAR, ELECTRIC_GUITAR_CLEAN]), PIANO_ACOUSTIC, BRASS);
      break;
  }
  return { padSpec, nonEssential };
}

function rollRock(rng: Rng): RosterRoll {
  const padSpec = rng.pick([SOFT_PAD, BRIGHT_PAD]);
  const nonEssential: LaneSpec[] = [ELECTRIC_GUITAR_DIST]; // distorted electric always
  // legacy: 50% chance of a second electric (clean or distorted)
  if (rng.pick([false, true])) {
    nonEssential.push(rng.pick([ELECTRIC_GUITAR_CLEAN, ELECTRIC_GUITAR_DIST]));
  }
  nonEssential.push(PIANO_ACOUSTIC); // keysAcousticPiano always
  return { padSpec, nonEssential };
}

function rollUrban(rng: Rng): RosterRoll {
  const padSpec = BRIGHT_PAD; // legacy fixes synthsBrightPad
  const nonEssential: LaneSpec[] = [];
  // legacy: 2-in-3 → keys (+ maybe analog synth); else lead/plucked + keys
  if (rng.pick([false, true, true])) {
    nonEssential.push(rng.pick([PIANO_ACOUSTIC, PIANO_ACOUSTIC, PIANO_ELECTRONIC]));
    if (rng.pick([false, false, true])) nonEssential.push(LEAD_ANALOG);
  } else {
    nonEssential.push(rng.pick([LEAD_SOFT, PLUCKED]));
    nonEssential.push(rng.pick([PIANO_ACOUSTIC, PIANO_ACOUSTIC, PIANO_ELECTRONIC]));
  }
  // legacy: trailing 1-in-2 pop-high-strings section (patterns.js:993-998).
  if (rng.pick([false, true])) nonEssential.push(STRINGS);
  return { padSpec, nonEssential };
}

// ===========================================================================
// Catalog resolution
// ===========================================================================

interface CandidatePool {
  readonly candidates: readonly ValidatedCatalogEntry[];
  /** 'genre' — picked row is genre-tagged; 'fallback' — explicitly tracked
   *  any-genre fallback (mirrors {@link selectLoop}). */
  readonly pickSource: 'genre' | 'fallback';
}

/**
 * The genre whose guitar sounds a genre's guitar lanes use (owner, 2026-11-25): urban takes the ballad
 * guitars; schlager, latin and EDM take the brightPop guitars; the rest their own.
 */
const GUITAR_SOUND_GENRE: Readonly<Record<string, string>> = { urban: 'ballad', schlager: 'brightPop', latin: 'brightPop', edm: 'brightPop' };

/** The genre a lane looks its sounds up under. */
function soundGenre(familyClass: InstrumentFamily, genre: string): string {
  return familyClass === 'guitar' ? (GUITAR_SOUND_GENRE[genre] ?? genre) : genre;
}

function candidatesFor(
  entries: readonly ValidatedCatalogEntry[],
  cfg: RoleConfig,
  genre: string,
): CandidatePool {
  const allowedFamilies = cfg.families ?? (cfg.family ? [cfg.family] : []);
  if (allowedFamilies.length === 0) {
    throw new Error('candidatesFor: RoleConfig has neither family nor families');
  }
  const inFamily = entries.filter((e) => {
    if (!allowedFamilies.includes(e.family)) return false;
    if (cfg.lowLevels && !cfg.lowLevels.includes(e.lowLevel)) return false;
    if (cfg.presetEquals && (e.preset === null || !cfg.presetEquals.includes(e.preset))) {
      return false;
    }
    return true;
  });

  // Style filter: mainStyle → addStyles → any-genre fallback (legacy default).
  const primary = inFamily.filter((e) => e.mainStyle === (genre as MainStyle));
  if (primary.length > 0) return { candidates: sortById(primary), pickSource: 'genre' };

  const addFallback = inFamily.filter((e) => e.addStyles.includes(genre as AddStyle));
  if (addFallback.length > 0) return { candidates: sortById(addFallback), pickSource: 'genre' };

  if (cfg.fallbackToAnyGenre !== false && inFamily.length > 0) {
    return { candidates: sortById(inFamily), pickSource: 'fallback' };
  }

  return { candidates: [], pickSource: 'genre' };
}

function sortById(
  entries: readonly ValidatedCatalogEntry[],
): readonly ValidatedCatalogEntry[] {
  return [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ===========================================================================
// Roster builder — resolves lane specs to catalog rows, assigns unique lane
// names, and supports per-segment "add one" appends.
// ===========================================================================

class RosterBuilder {
  readonly lanes: SelectedInstrument[] = [];
  private readonly usedIds = new Set<string>();
  private readonly nameCounts = new Map<string, number>();
  /** familyClass+':'+lowLevel → existing lane name (for add-one reuse). */
  private readonly laneByKey = new Map<string, string>();

  constructor(
    private readonly entries: readonly ValidatedCatalogEntry[],
    private readonly genre: string,
    private readonly rng: Rng,
    /** Lanes this song may not have (a genre recipe's: Casperaki Pop takes no acoustic or distorted guitar). */
    private readonly refuses: (spec: LaneSpec) => boolean = () => false,
  ) {}

  /** Resolve a spec to a fresh lane and append it. Returns the lane name, or
   *  undefined when the lane is unsupported for the genre (orchestral coverage
   *  gate) or the catalog has no candidate at all (lane skipped). */
  add(spec: LaneSpec, essential: boolean, perSegment = false): string | undefined {
    if (this.refuses(spec)) return undefined;
    if (!laneSupportedForGenre(spec.familyClass, this.genre)) return undefined;
    const pool = candidatesFor(this.entries, spec.cfg, soundGenre(spec.familyClass, this.genre));
    if (pool.candidates.length === 0) return undefined;
    const entry = this.pickDistinct(pool.candidates);
    const lane = this.assignName(spec.familyClass);
    this.lanes.push({
      lane,
      family: spec.familyClass,
      lowLevel: entry.lowLevel,
      entry,
      essential,
      perSegment,
      pickSource: pool.pickSource,
    });
    this.laneByKey.set(`${spec.familyClass}:${entry.lowLevel}`, lane);
    return lane;
  }

  /** Reuse an existing lane of the same family+lowLevel if present, else add a
   *  new per-segment lane (legacy `_addInstrument` per-segment tonal
   *  addition). */
  ensure(spec: LaneSpec): string | undefined {
    if (this.refuses(spec)) return undefined;
    if (!laneSupportedForGenre(spec.familyClass, this.genre)) return undefined;
    const pool = candidatesFor(this.entries, spec.cfg, soundGenre(spec.familyClass, this.genre));
    if (pool.candidates.length === 0) return undefined;
    // Probe a candidate's lowLevel for the reuse key (deterministic: first by
    // id). If a lane with that family+lowLevel already exists, reuse it.
    for (const cand of pool.candidates) {
      const existing = this.laneByKey.get(`${spec.familyClass}:${cand.lowLevel}`);
      if (existing) return existing;
    }
    return this.add(spec, false, true);
  }

  private pickDistinct(candidates: readonly ValidatedCatalogEntry[]): ValidatedCatalogEntry {
    const fresh = candidates.filter((e) => !this.usedIds.has(e.id));
    const entry = this.rng.pick(fresh.length > 0 ? fresh : candidates);
    this.usedIds.add(entry.id);
    return entry;
  }

  private assignName(family: InstrumentFamily): string {
    const base = LANE_BASE_NAME[family];
    const n = (this.nameCounts.get(base) ?? 0) + 1;
    this.nameCounts.set(base, n);
    return n === 1 ? base : `${base} ${n}`;
  }
}

// ===========================================================================
// Phase 2 — per-segment activation (port of ArrangementsClass.js:578-739)
// ===========================================================================

/** Compute the active lane names for a segment TYPE. Chorus = whole base
 *  roster; every other type = essentials + a rolled subset of non-essentials
 *  + a possible "add one" extra (which may append a new lane to `builder`).
 *
 *  `baseNonEssential` is the lane-name list of the BASE roster's
 *  non-essential lanes (excludes per-segment add-ones — legacy chorus uses
 *  `allInstrumentsUsedInPattern`, the pre-`_addInstrument` set). */
function activateType(
  rng: Rng,
  genre: string,
  type: string,
  builder: RosterBuilder,
  essentialLaneNames: readonly string[],
  baseNonEssential: readonly string[],
): string[] {
  if (type === 'chorus') {
    // Whole base roster (essentials + all base non-essentials).
    return [...essentialLaneNames, ...baseNonEssential];
  }

  const active = new Set<string>(essentialLaneNames);
  const N = baseNonEssential.length;
  if (N === 0) return [...active];

  // legacy: numberOfUsed = floor(rng * N) ∈ [0, N-1]; the rest are dropped.
  const used = rng.int(0, N - 1);
  const pool = [...baseNonEssential];
  for (let i = 0; i < used; i++) {
    const idx = rng.int(0, pool.length - 1);
    active.add(pool.splice(idx, 1)[0]!);
  }
  const dropped = N - used;

  // legacy: if ≥1 dropped, always add one extra (the `selectRandomly([true])`
  // gate is unconditionally true).
  if (dropped >= 1) {
    const permitted = (type === 'break' ? BREAK_ADD_ONE_SPECS : ADD_ONE_SPECS)[genre];
    if (permitted && permitted.length > 0) {
      const added = builder.ensure(rng.pick(permitted));
      if (added) active.add(added);
    }
    // legacy: edm/schlager also add a plucked synth on the non-break add path.
    if (type !== 'break' && (genre === 'edm' || genre === 'schlager')) {
      const pluck = builder.ensure(PLUCKED);
      if (pluck) active.add(pluck);
    }
  }

  return [...active];
}

// ===========================================================================
// Entry point
// ===========================================================================

/** Genres that get an optional guitar, and the guitar lanes they may take. */
const EXTRA_GUITAR_SPECS: Readonly<Record<string, readonly LaneSpec[]>> = {
  urban: [ACOUSTIC_GUITAR],
  schlager: [ACOUSTIC_GUITAR, ELECTRIC_GUITAR_CLEAN],
  edm: [ACOUSTIC_GUITAR, ELECTRIC_GUITAR_CLEAN],
};

/**
 * The extra guitar lane for a song, if any. Only once the genre has an approved pattern-lab guitar style
 * (the legacy guitar bank has nothing for these genres); then one song in three. A pattern-lab preview of
 * a guitar style always gets one.
 */
function extraGuitarSpec(rng: Rng, genre: string, params: Readonly<Record<string, unknown>> | undefined): LaneSpec | undefined {
  const specs = EXTRA_GUITAR_SPECS[genre];
  if (!specs) return undefined;
  const preview = params?.lanePreview as { family?: unknown } | undefined;
  if (preview?.family === 'guitar') return rng.pick(specs);
  if (authoredStylesFor('guitar', genre).length === 0) return undefined;
  if (!rng.pick([true, false, false])) return undefined;
  return rng.pick(specs);
}

export function selectInstruments(
  ctx: GeneratorContext,
  structure: SongStructure,
): SelectionResult {
  const genre = ctx.params.genre;
  if (!SUPPORTED_GENRES.has(genre)) {
    throw new Error(
      `selectInstruments: unsupported genre "${genre}" — supported: ${[...SUPPORTED_GENRES].join(', ')}`,
    );
  }

  const rng = ctx.rng.fork('selection');
  const catalog = loadValidatedCatalog();

  // --- Roster roll (Phase 1) ---
  const roll = rollRoster(rng.fork('roster'), genre);
  // A recipe that always plays a guitar takes no other kind of guitar (Casperaki Pop: clean electric only; owner
  // 2026-11-28 "syncopated electric guitars - ideally not distorted"). A second one is a clean electric too.
  const alwaysGuitars = (ctx.recipe?.alwaysPlays ?? []).map((lane) => ALWAYS_PLAYING_SPECS[lane]).filter((s) => s.familyClass === 'guitar');
  const refuses = (spec: LaneSpec) => alwaysGuitars.length > 0 && spec.familyClass === 'guitar' && !alwaysGuitars.includes(spec);
  const builder = new RosterBuilder(catalog.entries, genre, rng.fork('resolve'), refuses);

  // Essentials first (stable lane names): Drums, Bass, the mandatory pad.
  const essentialLaneNames: string[] = [];
  for (const spec of [DRUMS_SPEC, BASS_SPEC, roll.padSpec]) {
    const name = builder.add(spec, true);
    if (!name) {
      throw new Error(
        `selectInstruments: no candidates for essential lane "${spec.token}" (genre "${genre}")`,
      );
    }
    essentialLaneNames.push(name);
  }
  // A genre recipe's lanes that play in every section (Casperaki Pop: a clean electric guitar) are essential too.
  const always = (ctx.recipe?.alwaysPlays ?? []).map((lane) => ALWAYS_PLAYING_SPECS[lane]);
  const alwaysNames = new Map<AlwaysPlayingLane, string>();
  for (const [k, spec] of always.entries()) {
    const name = builder.add(spec, true);
    if (name) alwaysNames.set(ctx.recipe!.alwaysPlays[k]!, name);
    if (!name) throw new Error(`selectInstruments: no candidates for the always-playing lane "${spec.token}" (genre "${genre}")`);
    essentialLaneNames.push(name);
  }

  // Non-essential base roster (roll order). Lanes with zero candidates are
  // skipped (legacy never dropped for genre coverage, so this only fires for a
  // truly absent family — diagnostics-worthy but non-fatal).
  const baseNonEssential: string[] = [];
  for (const spec of roll.nonEssential.filter((s) => !always.includes(s))) {
    const name = builder.add(spec, false);
    if (name) baseNonEssential.push(name);
  }

  // Extra guitar (owner, 2026-11-25): genres whose legacy roster has no guitar get one in about a third of
  // songs, from its own draw so the rest of the roster is unchanged.
  const extra = extraGuitarSpec(rng.fork('roster/extraGuitar'), genre, ctx.params.params);
  if (extra) {
    const name = builder.add(extra, false);
    if (name) baseNonEssential.push(name);
  }

  // --- Loop pick (orthogonal sample lane) ---
  const loop = selectLoop(rng.fork('loop'), catalog.entries, genre, ctx.params.bpm);

  // --- Per-segment activation (Phase 2), computed once per segment TYPE ---
  const actRng = rng.fork('activate');
  const activeByType = new Map<string, string[]>();
  const segments: SegmentActivity[] = structure.map((segment) => {
    const type = segmentType(segment.name);
    let activeLanes = activeByType.get(type);
    if (!activeLanes) {
      activeLanes = activateType(
        actRng.fork(type),
        genre,
        type,
        builder,
        essentialLaneNames,
        baseNonEssential,
      );
      activeByType.set(type, activeLanes);
    }
    const loopActive = loop !== undefined && type === 'verse' && LOOP_GENRES.has(genre);
    return { segmentName: segment.name, activeLanes: [...activeLanes], loopActive };
  });

  const instruments = builder.lanes;
  const recipeSegments = recipeSectionParts(ctx, segments, instruments.map((l) => l.lane), essentialLaneNames, alwaysNames, rng.fork('recipe/sections'));
  return loop ? { instruments, segments: recipeSegments, loop } : { instruments, segments: recipeSegments };
}

/** A genre recipe's fixed section parts (Casperaki Pop: a lean verse, a full chorus; owner 2026-11-28 "more instrument
 *  variety between verse and chorus"). The extra part of a section type is drawn once per song. */
function recipeSectionParts(
  ctx: GeneratorContext,
  segments: readonly SegmentActivity[],
  allLanes: readonly string[],
  essentialLaneNames: readonly string[],
  alwaysNames: ReadonlyMap<AlwaysPlayingLane, string>,
  rng: Rng,
): SegmentActivity[] {
  const parts = ctx.recipe?.sectionParts ?? {};
  const busier = ctx.recipe?.busierThan ?? {};
  const nameOf = (k: 'drums' | 'bass' | AlwaysPlayingLane): string => {
    const n = k === 'drums' ? essentialLaneNames[0] : k === 'bass' ? essentialLaneNames[1] : alwaysNames.get(k);
    if (!n) throw new Error(`selectInstruments: the recipe keeps "${k}" in a section but the song has no such track`);
    return n;
  };
  // Fixed sections first (one set of parts per section type, its extra part drawn once per song).
  const fixedByType = new Map<string, string[]>();
  for (const [type, rule] of Object.entries(parts)) {
    const keep = rule.keep.map(nameOf);
    const others = allLanes.filter((l) => !keep.includes(l) && ![...alwaysNames.values()].includes(l));
    const extra = rule.plusOne && others.length > 0 ? rng.fork(type).pick(others) : undefined;
    fixedByType.set(type, extra ? [...keep, extra] : keep);
  }
  const fixed = segments.map((seg) => {
    const lanes = fixedByType.get(segmentType(seg.segmentName));
    return lanes ? { ...seg, activeLanes: [...lanes] } : { ...seg };
  });
  // A busier section type keeps its own (rotating) draw; topped up with tracks it lacks, at random, until it has
  // more than the section type it must beat (the most that type has in any of its sections).
  const most = (type: string) => Math.max(0, ...fixed.filter((s) => segmentType(s.segmentName) === type).map((s) => s.activeLanes.length));
  const topUpByType = new Map<string, string[]>();
  return fixed.map((seg) => {
    const type = segmentType(seg.segmentName);
    const than = busier[type];
    if (!than) return seg;
    let added = topUpByType.get(type);
    if (!added) {
      added = [];
      const pool = allLanes.filter((l) => !seg.activeLanes.includes(l));
      const r = rng.fork(`busier/${type}`);
      while (seg.activeLanes.length + added.length <= most(than) && pool.length > 0) added.push(pool.splice(r.int(0, pool.length - 1), 1)[0]!);
      if (seg.activeLanes.length + added.length <= most(than)) throw new Error(`selectInstruments: a ${type} cannot have more tracks than the ${than} (the song has ${allLanes.length})`);
      topUpByType.set(type, added);
    }
    return { ...seg, activeLanes: [...seg.activeLanes, ...added.filter((l) => !seg.activeLanes.includes(l))] };
  });
}

/** Pick a deterministic percussion-loop catalog row at the song bpm, per the
 *  legacy `ArrangementsClass._addInstrument({instrumentGroup:'percussion'})`
 *  rule. Genre-tagged rows preferred; any-genre rows at the bpm as fallback
 *  (catalog/disk drift — docs/54r). Returns undefined when the genre isn't
 *  loop-driven or no row matches the bpm. */
function selectLoop(
  rng: Rng,
  entries: readonly ValidatedCatalogEntry[],
  genre: string,
  bpm: number,
): SelectedLoop | undefined {
  if (!LOOP_GENRES.has(genre)) return undefined;

  const inFamily = entries.filter(
    (e) =>
      e.family === 'percussionLoops' &&
      (e.lowLevel.startsWith('percussionLoopsAcoustic') ||
        e.lowLevel.startsWith('percussionLoopsElectronic')) &&
      e.bpm === bpm,
  );
  if (inFamily.length === 0) return undefined;

  const inGenre = inFamily.filter(
    (e) =>
      e.mainStyle === (genre as MainStyle) ||
      e.addStyles.includes(genre as AddStyle),
  );
  const pool = inGenre.length > 0 ? sortById(inGenre) : sortById(inFamily);
  const entry = rng.pick(pool);
  return {
    displayName: LOOP_DISPLAY_NAME,
    entry,
    pickSource: inGenre.length > 0 ? 'genre' : 'fallback',
  };
}

export { LOOP_GENRES, LOOP_DISPLAY_NAME };

function segmentType(name: string): string {
  // Step-4 emits lowercase camelCase: intro, verse[N], preChorus[N],
  // chorus[N], bridge[N], break[N], outro. Order matters — `preChorus`
  // starts with `pre`, must be matched before `chorus`/`verse`.
  if (name === 'intro' || name.startsWith('intro')) return 'intro';
  if (name === 'outro' || name.startsWith('outro')) return 'outro';
  if (name.startsWith('preChorus')) return 'preChorus';
  if (name.startsWith('chorus')) return 'chorus';
  if (name.startsWith('verse')) return 'verse';
  if (name.startsWith('bridge')) return 'bridge';
  if (name.startsWith('break')) return 'break';
  return name;
}

// ===========================================================================
// Track editing support (sequencer: change sound / add track)
// ===========================================================================

const ALL_LANE_SPECS: readonly LaneSpec[] = [
  DRUMS_SPEC, BASS_SPEC, SOFT_PAD, BRIGHT_PAD, ACOUSTIC_GUITAR, ELECTRIC_GUITAR_CLEAN,
  ELECTRIC_GUITAR_DIST, PIANO_ACOUSTIC, PIANO_ELECTRONIC, LEAD_SOFT, LEAD_BRIGHT, LEAD_ANALOG,
  PLUCKED, STRINGS, BRASS,
];

/** Lane display-name base per family (`Keys`, `Pad`, …); duplicates add ` 2`, ` 3`. */
export const LANE_BASE_NAMES: Readonly<Record<InstrumentFamily, string>> = LANE_BASE_NAME;

/** The family of a lane by its display name (`Keys 2` → keys), or undefined
 *  for lanes that are not generator families (Vocal, Loop, transitions). */
export function laneFamilyOf(lane: string): InstrumentFamily | undefined {
  const base = lane.replace(/\s+\d+$/u, '');
  const hit = (Object.entries(LANE_BASE_NAME) as [InstrumentFamily, string][]).find(([, b]) => b === base);
  return hit?.[0];
}

/** Every catalog sound a lane of `family` may use in `genre`: the union of the
 *  pools of all the family's lane specs (the same filters and genre preference
 *  the selection step uses), sorted by id. Empty when the genre has no pattern
 *  coverage for the family (orchestral gate) or the catalog has no candidate. */
export function familySoundPool(family: InstrumentFamily, genre: string): readonly ValidatedCatalogEntry[] {
  if (!SUPPORTED_GENRES.has(genre)) throw new Error(`familySoundPool: unsupported genre "${genre}"`);
  if (!USER_ANY_GENRE.has(family) && !laneSupportedForGenre(family, genre)) return [];
  const entries = loadValidatedCatalog().entries;
  const byId = new Map<string, ValidatedCatalogEntry>();
  for (const spec of ALL_LANE_SPECS) {
    if (spec.familyClass !== family) continue;
    for (const e of candidatesFor(entries, spec.cfg, soundGenre(family, genre)).candidates) byId.set(e.id, e);
  }
  return sortById([...byId.values()]);
}

/**
 * The track family a library sound can be used on when the user picks it
 * (Use in song, Change sound), regardless of the genre's own pool:
 * keys → keys, basses → bass, pads → pad, plucked synths → pluckedSynths,
 * lead synths → synths, guitars → guitar, pop strings / brass → themselves.
 * Undefined for sounds no track type plays (orchestral, wobble-bass tempo
 * loops, drum hits, loops, fx).
 */
export function userSoundFamily(entry: Pick<ValidatedCatalogEntry, 'family' | 'lowLevel'>): InstrumentFamily | undefined {
  switch (entry.family) {
    case 'keys':
      return 'keys';
    case 'basses':
      return entry.lowLevel === 'bassesSynthWobble' ? undefined : 'bass';
    case 'synths':
      return entry.lowLevel === 'synthsPlucked' ? 'pluckedSynths' : 'pad';
    case 'leadSynths':
      return 'synths';
    case 'electricGuitars':
    case 'acousticGuitars':
      return 'guitar';
    case 'popStrings':
      return 'popStrings';
    case 'popBrass':
      return 'popBrass';
    default:
      return undefined;
  }
}

/** A sound the user picked for a track of `family`: in the genre's pool, or any library sound of that family. */
export function userSoundFor(family: InstrumentFamily, genre: string, soundId: string): ValidatedCatalogEntry | undefined {
  const pooled = familySoundPool(family, genre).find((e) => e.id === soundId);
  if (pooled) return pooled;
  const entry = loadValidatedCatalog().entries.find((e) => e.id === soundId);
  return entry && userSoundFamily(entry) === family ? entry : undefined;
}
