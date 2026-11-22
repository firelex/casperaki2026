// The render engine's view of a chord symbol, for the guitar strum pool.
//
// The engine (apps/web/wasm/engine/src/music/Chord.h + Guitar.h, a faithful
// port of casperaki_engine's JUCE Guitar.h:246-322) looks every strum up by
//   <root spelled with sharps><collapsed suffix>_<position>_<strum type>
// where the suffix collapses the parsed chord type onto one of the eight
// flavours the virtual-guitarist sample set ships. The adapter must name its
// `virtualGuitaristSamples[]` entries with exactly that string, or the engine
// misses the key and drops the rest of that segment's strums.
//
// `@casperaki/music-theory`'s parseChord is NOT reused: it prefix-matches the
// quality (so "maj13" parses as "maj" and "11" is unknown) and spells roots
// differently ("Cb" → B), while this must equal the engine's table exactly.

/** Chord.h ChordType names, in enum order. */
export type EngineChordType =
  | 'major' | 'minor' | 'Mdim' | 'Mdim7' | 'Msus2' | 'Msus4' | 'M7sus4' | 'M5'
  | 'Malt' | 'Maug' | 'M6' | 'M69' | 'M7' | 'M7b5' | 'Maug7' | 'M9' | 'M9b5'
  | 'Maug9' | 'M7b9' | 'M7s9' | 'M11' | 'M9s11' | 'M13' | 'Mmaj7' | 'Mmaj7b5'
  | 'Mmaj7s5' | 'Mmaj9' | 'Mmaj11' | 'Mmaj13' | 'm6' | 'm7' | 'm7b5' | 'm9'
  | 'm69' | 'm11' | 'mmaj7' | 'mmaj7b5' | 'mmaj9' | 'mmaj11' | 'Madd9' | 'madd9';

/** Chord.h typeTable: chord-type string (the part after the root) → type. */
export const ENGINE_CHORD_TYPE_TABLE: Readonly<Record<string, EngineChordType>> = {
  major: 'major', '': 'major', minor: 'minor', m: 'minor',
  dim: 'Mdim', dim7: 'Mdim7', sus2: 'Msus2', sus4: 'Msus4',
  sus: 'Msus4', '7sus4': 'M7sus4', '5': 'M5', alt: 'Malt',
  aug: 'Maug', '6': 'M6', '69': 'M69', '7': 'M7', '7b5': 'M7b5',
  aug7: 'Maug7', '9': 'M9', '9b5': 'M9b5', aug9: 'Maug9',
  '7b9': 'M7b9', '7#9': 'M7s9', '11': 'M11', '9#11': 'M9s11',
  '13': 'M13', maj7: 'Mmaj7', maj7b5: 'Mmaj7b5', 'maj7#5': 'Mmaj7s5',
  maj9: 'Mmaj9', maj11: 'Mmaj11', maj13: 'Mmaj13', m6: 'm6',
  m7: 'm7', m7b5: 'm7b5', m9: 'm9', m69: 'm69', m11: 'm11',
  mmaj7: 'mmaj7', mmaj7b5: 'mmaj7b5', mmaj9: 'mmaj9',
  mmaj11: 'mmaj11', add9: 'Madd9', madd9: 'madd9',
};

/** Guitar.h virtualGuitaristSuffix: chord type → the shipped sample flavour. */
export const VIRTUAL_GUITARIST_SUFFIX: Readonly<Record<EngineChordType, string>> = {
  major: '', Mdim: '', M5: '', Malt: '', Maug: '',
  Mdim7: '7', M7: '7', M7b5: '7', Maug7: '7', M7b9: '7', M7s9: '7',
  Mmaj7: '7', Mmaj7b5: '7', Mmaj7s5: '7',
  Msus2: 'sus2',
  Msus4: 'sus4', M7sus4: 'sus4',
  M6: '6', M69: '6', M13: '6', Mmaj13: '6',
  M9: '9', M9b5: '9', Maug9: '9', M9s11: '9', Mmaj9: '9', Madd9: '9', M11: '9', Mmaj11: '9',
  minor: 'm', m6: 'm', m9: 'm', m69: 'm', mmaj9: 'm', m11: 'm', mmaj11: 'm', madd9: 'm',
  m7: 'm7', m7b5: 'm7', mmaj7: 'm7', mmaj7b5: 'm7',
};

/** Note.h sharp spellings (getMidiNoteName with useSharps=true). */
const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
/** Note.h flat spellings, upper-cased as the engine compares them. */
const FLAT_NAMES = ['C', 'DB', 'D', 'EB', 'E', 'F', 'GB', 'G', 'AB', 'A', 'BB', 'B'] as const;

// Chord.h string ctor: std::regex_search, i.e. the FIRST match anywhere in the
// string (so "C/E" parses as C major, the slash bass ignored as the engine does).
const ENGINE_CHORD_REGEX = /([A-Ga-g][#b]{0,1})([A-Za-z0-9#]*)/u;

export interface EngineChord {
  /** Root pitch class 0..11. */
  root: number;
  type: EngineChordType;
}

/** Parse a chord symbol the way the engine's Chord(string) does. Throws where
 *  the engine would yield a garbage key: no match, a root its note tables do
 *  not know (Cb, Fb, E#, B#), or a type string missing from its table. */
export function parseEngineChord(symbol: string): EngineChord {
  const m = ENGINE_CHORD_REGEX.exec(symbol);
  if (!m) throw new Error(`engine-adapter: cannot parse chord symbol "${symbol}" (no root letter A-G)`);
  const rootStr = m[1]!.toUpperCase();
  let root: number = SHARP_NAMES.indexOf(rootStr as (typeof SHARP_NAMES)[number]);
  if (root === -1) root = FLAT_NAMES.indexOf(rootStr as (typeof FLAT_NAMES)[number]);
  if (root === -1) {
    throw new Error(`engine-adapter: chord "${symbol}" has root "${m[1]}", which the render engine cannot spell`);
  }
  const typeStr = m[2]!;
  if (!Object.prototype.hasOwnProperty.call(ENGINE_CHORD_TYPE_TABLE, typeStr)) {
    throw new Error(`engine-adapter: chord "${symbol}" has type "${typeStr}", which the render engine does not know`);
  }
  return { root, type: ENGINE_CHORD_TYPE_TABLE[typeStr]! };
}

/** The chord part of the engine's strum sample key (Guitar.h strumSampleKey):
 *  sharp-spelled root + collapsed suffix, e.g. "Fmaj7" → "F7", "Bbm9" → "A#m". */
export function virtualGuitaristChordName(chord: EngineChord): string {
  return SHARP_NAMES[chord.root]! + VIRTUAL_GUITARIST_SUFFIX[chord.type];
}

/** The engine's chord for a beat past the segment's last bar
 *  (Tonal.h getChordAtTime → Chord(Note 0, invalidChord)): its strum key
 *  spells root C with the empty suffix. */
export const OUT_OF_SEGMENT_STRUM_CHORD = 'C';
