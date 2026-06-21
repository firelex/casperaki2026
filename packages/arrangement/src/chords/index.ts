// Chord generator (53r — bank-wired).
//
// Takes a `SongStructure` (the empty-bars shape from the structure step)
// and returns a NEW structure with each bar's `chords` populated.
//
// Every segment's progression comes from the imported legacy bank
// (`data/precedent-bank.json`, 79 entries, docs/53m). One bank entry
// is picked per role (verse → preChorus → chorus) at the top of the
// segment walk and reused across every segment of that role —
// mirrors the legacy `ChordsClass.js` `songIndex` cache (each chosen
// chorus repeats for every chorus segment).
//
// Pass-2 (intro / break / outro) ports legacy `ChordsClass.js:178-268`:
//   - intro:  random ∈ {verse | beginningOfChorus | endOfChorus} — sliced
//             from the cached verse1 / chorus1 bars.
//   - break:  the cached verse1 bar[0] repeated for the whole segment.
//   - outro:  random ∈ {beginningOfChorus | endOfChorus}.
// `bridge` is a Pass-1 segment in legacy: it picks a FRESH entry from the
// full bank per bridge (uncached), unlike verse/preChorus/chorus which cache
// one pick per role. Pass-1 also ports `normalizedLengthInBars` (floor-to-4 +
// 2-bar repeat tail, legacy :115-153) and the `chordStructure` fingerprint
// (legacy :159) onto every filled segment.
//
// `data/precedents.json` is no longer read at runtime — the file
// stays on disk as historical Phase-3 scaffolding (its $description
// records this). All chord output is bank-derived.
//
// Determinism: every RNG draw comes from `ctx.rng.fork('chords')`. The
// frozen `'chords'` salt from 53j is now load-bearing: same seed →
// byte-identical chord output; different seeds → different picks
// (cross-seed canary flipped per 53k campaign rule).
//
// Genre support: every canonical brain genre in `GenreSchema` is
// supported via the same bank — the legacy `ChordsClass` ran the
// bank unfiltered for every song, so this PR does too. Per-genre
// progression banks are deferred (docs/53r §"Per-genre gaps").
// Non-canonical genres (including the Phase-3 placeholder `'pop'`)
// throw with a clear message; there is no compatibility alias.
//
// The input structure is treated as read-only; we map over it.

import { degreePitchClass, parseKey, beatsPerBar, type ParsedKey, type Rng } from '@casperaki/music-theory';
import {
  ChordSymbolSchema,
  GenreSchema,
  type ChordSymbol,
  type Segment,
  type SongStructure,
} from '@casperaki/song-schema';

import type { GeneratorContext } from '../context.js';
import {
  filterBankByRole,
  loadChordBank,
  selectBankEntry,
  type BankEntry,
  type BankRole,
} from './bank.js';
import {
  loadChordsVocab,
  type ChordsVocab,
  type RomanNumeralEntry,
} from './data.js';

// Sharps-only pitch-class names — the ChordSymbol regex accepts both
// spellings, and sharps keep the vocabulary unambiguous without an
// enharmonic key-signature table.
const PITCH_CLASS_NAMES: readonly string[] = [
  'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B',
];

const ROLE_TYPES = new Set<string>(['verse', 'preChorus', 'chorus']);
const ALL_SEGMENT_TYPES = new Set<string>([
  'verse', 'preChorus', 'chorus', 'intro', 'bridge', 'break', 'outro',
]);

export function generateChords(
  ctx: GeneratorContext,
  structure: SongStructure,
): SongStructure {
  // Gate genre at the boundary. The brain endpoint already enforces this
  // via Zod, but a direct caller (test fixture, future pipeline) gets a
  // clear error here too. Validation reuses `GenreSchema` so the
  // canonical-vocabulary policy lives in one place (53o).
  const genreParse = GenreSchema.safeParse(ctx.params.genre);
  if (!genreParse.success) {
    throw new Error(
      `generateChords: unsupported genre "${ctx.params.genre}" — ` +
        `only canonical brain genres are accepted (${GenreSchema.options.join(', ')})`,
    );
  }

  const rng = ctx.rng.fork('chords');
  const vocab = loadChordsVocab();
  const key = parseKey(ctx.params.key);
  const beats = beatsPerBar();

  // Pick one bank entry per role. Order is fixed (verse → preChorus →
  // chorus) so the RNG stream is stable across structures with
  // different segment compositions.
  const bank = loadChordBank();
  const picks = pickRoleEntries(bank, rng);

  const out: Segment[] = structure.map((s) => ({ ...s }));

  // ---- Pass 1 — verse / preChorus / chorus / bridge -------------------
  // Caches the FIRST instance of each role (legacy `songIndex[...]['bars']`,
  // set only at verse1 / preChorus1 / chorus1) for Pass-2 derivation.
  const cache: Partial<Record<BankRole, FilledSegment>> = {};
  for (let i = 0; i < out.length; i++) {
    const segment = out[i]!;
    const type = baseType(segment.name);
    let entry: BankEntry | undefined;
    if (ROLE_TYPES.has(type)) {
      entry = picks[type as BankRole];
    } else if (type === 'bridge') {
      // Legacy: bridge falls through to the default candidate pool (the full
      // bank) and is NOT cached — a fresh pick per bridge segment.
      entry = selectBankEntry(bank, rng);
    } else {
      continue; // intro / break / outro → Pass 2
    }
    const filled = fillFromBank(segment, entry, vocab, key, beats);
    out[i] = {
      ...segment,
      bars: filled.bars,
      chordStructure: filled.chordStructure,
      precedent: entry.precedent,
    };
    if (ROLE_TYPES.has(type) && cache[type as BankRole] === undefined) {
      cache[type as BankRole] = filled;
    }
  }

  // ---- Pass 2 — intro / break / outro ---------------------------------
  for (let i = 0; i < out.length; i++) {
    const segment = out[i]!;
    const type = baseType(segment.name);
    if (type !== 'intro' && type !== 'break' && type !== 'outro') continue;
    out[i] = derivePass2(segment, type, cache, picks, vocab, key, beats, rng);
  }

  return out;
}

interface RolePicks {
  readonly verse: BankEntry;
  readonly preChorus: BankEntry;
  readonly chorus: BankEntry;
}

/** A fully-resolved segment body (legacy `songIndex[type]`). */
interface FilledSegment {
  readonly bars: Segment['bars'];
  readonly chordStructure: string;
}

function pickRoleEntries(bank: readonly BankEntry[], rng: Rng): RolePicks {
  // Order matters: changing it would shift every subsequent draw on the
  // 'chords' stream. Keep verse → preChorus → chorus.
  const verse = selectBankEntry(filterBankByRole(bank, 'verse'), rng);
  const preChorus = selectBankEntry(filterBankByRole(bank, 'preChorus'), rng);
  const chorus = selectBankEntry(filterBankByRole(bank, 'chorus'), rng);
  return { verse, preChorus, chorus };
}

function cloneBar(bar: Segment['bars'][number]): Segment['bars'][number] {
  return { ...bar, chords: [...bar.chords] };
}

/**
 * Fill a segment from a bank entry — ports legacy `ChordsClass.js:115-159`:
 * `normalizedLengthInBars` (floor the length to a multiple of 4, or keep it if
 * <4), fill those bars at `i % 4`, then a 2-bar / single-bar repeat tail for
 * the remainder, plus the per-bar `chordStructure` fingerprint (A/B/C… letters
 * keyed by the bank bar's numeral signature; covers only the normalized bars).
 */
function fillFromBank(
  segment: Segment,
  entry: BankEntry,
  vocab: ChordsVocab,
  key: ParsedKey,
  beats: number,
): FilledSegment {
  const lengthInBars = segment.bars.length;
  let normalized = Math.floor(lengthInBars / 4) * 4;
  if (normalized === 0) normalized = lengthInBars;

  const bars: Segment['bars'] = [];
  let chordStructure = '';
  const structureMap: Record<string, string> = {};
  let nextLetter = 'A';

  for (let i = 0; i < normalized; i++) {
    const sourceBar = entry.bars[i % entry.bars.length]!;
    const chords: ChordSymbol[] = Array.from({ length: beats }, (_, b) =>
      numeralToChordSymbol(sourceBar[b % sourceBar.length]!, vocab, key),
    );
    bars.push({ chords });

    const signature = sourceBar.join('');
    if (structureMap[signature] === undefined) {
      structureMap[signature] = nextLetter;
      nextLetter = String.fromCharCode(nextLetter.charCodeAt(0) + 1);
    }
    chordStructure += structureMap[signature];
  }

  // Repeat tail (legacy :140-153) — the remainder (1–3 bars) repeats the last
  // bar(s) of the normalized section rather than continuing the i%4 cycle.
  for (let i = normalized; i < lengthInBars; i += 2) {
    if (i <= lengthInBars - 2) {
      bars.push(cloneBar(bars[bars.length - 2]!));
      bars.push(cloneBar(bars[bars.length - 2]!));
    } else {
      bars.push(cloneBar(bars[bars.length - 1]!));
    }
  }

  return { bars, chordStructure };
}

function derivePass2(
  segment: Segment,
  type: 'intro' | 'break' | 'outro',
  cache: Partial<Record<BankRole, FilledSegment>>,
  picks: RolePicks,
  vocab: ChordsVocab,
  key: ParsedKey,
  beats: number,
  rng: Rng,
): Segment {
  const len = segment.bars.length;
  // Legacy reads `songIndex['verse'/'chorus']` — present whenever the song
  // has a verse1 / chorus1 (it always does). Fall back to a fresh fill of the
  // role pick at this segment's own length so a verse/chorus-less structure
  // never throws (legacy would crash).
  const verseSrc = cache.verse ?? fillFromBank(segment, picks.verse, vocab, key, beats);
  const chorusSrc = cache.chorus ?? fillFromBank(segment, picks.chorus, vocab, key, beats);

  const sliceHead = (src: FilledSegment): Segment['bars'] =>
    src.bars.slice(0, len).map(cloneBar);
  const sliceTail = (src: FilledSegment): Segment['bars'] =>
    src.bars.slice(src.bars.length - len).map(cloneBar);

  if (type === 'break') {
    // Legacy :222-236 — verse bar[0] held for the whole break.
    const head = verseSrc.bars[0];
    const bars: Segment['bars'] = Array.from({ length: len }, () =>
      head ? cloneBar(head) : { chords: [] },
    );
    const fp = verseSrc.chordStructure[0] ?? '';
    return { ...segment, bars, precedent: 'verse', chordStructure: fp.repeat(len) };
  }

  if (type === 'intro') {
    switch (rng.pick(['verse', 'beginningOfChorus', 'endOfChorus'])) {
      case 'verse':
        return {
          ...segment,
          bars: sliceHead(verseSrc),
          precedent: 'verse',
          chordStructure: verseSrc.chordStructure.substring(0, len),
        };
      case 'beginningOfChorus':
        return {
          ...segment,
          bars: sliceHead(chorusSrc),
          precedent: 'beginningOfChorus',
          chordStructure: chorusSrc.chordStructure.substring(0, len),
        };
      default:
        return {
          ...segment,
          bars: sliceTail(chorusSrc),
          precedent: 'endOfChorus',
          // Legacy :214 — substring start = chorus.bars.length − len.
          chordStructure: chorusSrc.chordStructure.substring(chorusSrc.bars.length - len),
        };
    }
  }

  // outro (legacy :238-262)
  switch (rng.pick(['beginningOfChorus', 'endOfChorus'])) {
    case 'beginningOfChorus':
      return {
        ...segment,
        bars: sliceHead(chorusSrc),
        precedent: 'beginningOfChorus',
        chordStructure: chorusSrc.chordStructure.substring(0, len),
      };
    default:
      return {
        ...segment,
        bars: sliceTail(chorusSrc),
        precedent: 'endOfChorus',
        // Legacy :258 — substring start = len (NOT bars.length − len; this
        // asymmetry vs the intro endOfChorus case is a faithful legacy quirk).
        chordStructure: chorusSrc.chordStructure.substring(len),
      };
  }
}

/** Strip the trailing digits off a segment name. `verse1` → `verse`,
 *  `preChorus2` → `preChorus`, `intro` → `intro`. Mirrors the legacy
 *  `segment.match(/[^0-9]+/)[0]` idiom. */
function baseType(name: string): string {
  const m = /^[^0-9]+/u.exec(name);
  return m ? m[0]! : name;
}

function numeralToChordSymbol(
  roman: string,
  vocab: ChordsVocab,
  key: ParsedKey,
): ChordSymbol {
  const entry: RomanNumeralEntry | undefined = vocab.romanNumerals[roman];
  if (!entry) {
    throw new Error(`generateChords: unknown roman numeral "${roman}"`);
  }
  let pc = degreePitchClass(key, entry.degree);
  if (entry.accidental) pc = (pc + entry.accidental + 12) % 12;
  const rootName = PITCH_CLASS_NAMES[pc]!;
  const suffix = vocab.qualitySymbols[entry.quality];
  if (suffix === undefined) {
    throw new Error(`generateChords: unknown quality "${entry.quality}"`);
  }
  return ChordSymbolSchema.parse(`${rootName}${suffix}`);
}
