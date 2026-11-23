// The public sound catalog behind the Sounds page: every sound with its public
// name only (never library, preset, file path or other original names), the
// families with counts, and how each sound can be previewed:
//   'pattern' — a tonal sound whose file the audit matched: previewed as a
//               short generated pattern. A sound a genre uses gets a pattern
//               written for it; any other sound plays the pattern written for
//               a similar sound a genre uses (its "donor": same kind where
//               possible, e.g. a nylon mono guitar plays a nylon stereo
//               guitar's part, a legato orchestral string section a pad part)
//   'sample'  — a drum hit, loop, break, effect, transition sound or single
//               percussion hit: played through the engine on its own (the
//               Drums track, the Loop track or a transition), once or looped
//               (see enginePreview.ts)
//   'none'    — none of these (its file is missing from the library, or it
//               lacks what the engine needs, e.g. a tempo)
// Every preview goes through the playback engine; no raw file is played.
// Wobble basses are tempo loops, so they are previewed as audio (looped).

import {
  familySoundPool,
  InstrumentFamilySchema,
  loadEffectiveCatalogSnapshot,
  loadValidatedCatalog,
  publicNameOf,
  type InstrumentFamily,
  type ValidatedCatalogEntry,
  type DrumRole,
  userSoundFamily,
  isSwappableTransition,
  transitionSoundChoices,
  TRANSITION_TYPES,
  drumRolesForFamily,
} from '@casperaki/arrangement';
import { GenreSchema } from '@casperaki/song-schema';

import { drumPreviewGenres, drumPreviewRoles, samplePlanFor, type SamplePlan } from './enginePreview.js';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type SoundPreview = 'pattern' | 'sample' | 'none';
export type SoundGroup = 'Instruments' | 'Drum hits' | 'Loops & breaks' | 'FX';

export interface SoundItem {
  readonly id: string;
  readonly name: string;
  readonly family: string;
  readonly familyLabel: string;
  readonly type: string;
  readonly styles: readonly string[];
  readonly bpm: number | null;
  readonly key: string | null;
  readonly preview: SoundPreview;
  /** The track kind it can be used on in a song (Use / Change sound), or null. */
  readonly useAs: InstrumentFamily | null;
  /** Drum hits: the kit's drums it can replace (engine roles, e.g. snareDrum1); [] otherwise. */
  readonly drumRoles: readonly string[];
}

export interface SoundFamily {
  readonly id: string;
  readonly label: string;
  readonly group: SoundGroup;
  readonly count: number;
}

/** Catalog families in display order, with their label and group. Vocals are left out. */
export const FAMILIES: readonly { id: string; label: string; group: SoundGroup }[] = [
  { id: 'keys', label: 'Keys', group: 'Instruments' },
  { id: 'synths', label: 'Synths', group: 'Instruments' },
  { id: 'leadSynths', label: 'Lead synths', group: 'Instruments' },
  { id: 'basses', label: 'Basses', group: 'Instruments' },
  { id: 'electricGuitars', label: 'Electric guitars', group: 'Instruments' },
  { id: 'acousticGuitars', label: 'Acoustic guitars', group: 'Instruments' },
  { id: 'popStrings', label: 'Strings', group: 'Instruments' },
  { id: 'popBrass', label: 'Brass', group: 'Instruments' },
  { id: 'orchestral', label: 'Orchestral', group: 'Instruments' },
  { id: 'kickDrums', label: 'Kicks', group: 'Drum hits' },
  { id: 'snareDrums', label: 'Snares', group: 'Drum hits' },
  { id: 'clapsSnaps', label: 'Claps & snaps', group: 'Drum hits' },
  { id: 'hiHatsClosed', label: 'Closed hi-hats', group: 'Drum hits' },
  { id: 'hiHatsOpen', label: 'Open hi-hats', group: 'Drum hits' },
  { id: 'cymbals', label: 'Cymbals', group: 'Drum hits' },
  { id: 'toms', label: 'Toms', group: 'Drum hits' },
  { id: 'shakers', label: 'Shakers', group: 'Drum hits' },
  { id: 'percussionMisc', label: 'Percussion', group: 'Drum hits' },
  { id: 'percussionLoops', label: 'Percussion loops', group: 'Loops & breaks' },
  { id: 'percussionBreaks', label: 'Breaks', group: 'Loops & breaks' },
  { id: 'fx', label: 'FX', group: 'FX' },
];

const FAMILY_BY_ID = new Map(FAMILIES.map((f) => [f.id, f]));

/** "keysAcousticPiano" (family keys) → "Acoustic piano"; "percussionLoopsElectronic_120-150bpm" → "Electronic 120–150 bpm". */
export function typeLabel(family: string, lowLevel: string, familyLabel: string): string {
  const rest = lowLevel.startsWith(family) ? lowLevel.slice(family.length) : lowLevel;
  const [main = '', ...extras] = rest.split('_');
  const words = main
    .replace(/([a-z])([A-Z0-9])/gu, '$1 $2')
    .replace(/([0-9])([A-Z])/gu, '$1 $2')
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .map((w, i) => (i === 0 ? w[0]!.toUpperCase() + w.slice(1) : w.toLowerCase()));
  const tail = extras.map((x) => x.replace(/^(\d+)-(\d+)bpm$/u, '$1–$2 bpm').replace(/^(\d+)bpm$/u, '$1 bpm'));
  const label = [...words, ...tail].join(' ');
  return label || familyLabel;
}

interface Built {
  readonly items: readonly SoundItem[];
  readonly byId: ReadonlyMap<string, SoundItem>;
  /** Pattern sounds: the generator family, genre and donor sound (itself when a genre uses it) to preview them with. */
  readonly patternOf: ReadonlyMap<string, PatternPreview>;
  /** Every validated entry by id. */
  readonly validated: ReadonlyMap<string, ValidatedCatalogEntry>;
  /** Drum hits: the kit positions they fill and the styles that write grooves. */
  readonly drumOf: ReadonlyMap<string, { readonly roles: readonly DrumRole[]; readonly genres: readonly string[]; readonly entry: ValidatedCatalogEntry }>;
  /** Loops, breaks, effects, transition sounds, percussion hits: how the engine plays them. */
  readonly sampleOf: ReadonlyMap<string, { readonly plan: SamplePlan; readonly entry: ValidatedCatalogEntry }>;
  /** Sounds that cannot be previewed, and why (for the details panel). */
  readonly noPreview: ReadonlyMap<string, string>;
}

export interface PatternPreview {
  readonly family: InstrumentFamily;
  /** Genres that use the donor, best first (the preview uses the first that writes a part). */
  readonly genres: readonly string[];
  /** The sound whose generated part is played (the sound itself when a genre uses it). */
  readonly donorId: string;
  /** The sound to play it with (validated: its file exists). */
  readonly entry: ValidatedCatalogEntry;
}

let built: Built | undefined;

/**
 * For a tonal sound no genre uses: which generator family writes its part,
 * and the donor kinds (lowLevels) to prefer, best first.
 */
function donorKind(family: string, lowLevel: string): { family: InstrumentFamily; prefer: string[] } {
  const short = /Staccato|Pizzicato|Hit$/u.test(lowLevel);
  const low = /Low|Bass|Cello/u.test(lowLevel);
  switch (family) {
    case 'keys':
      return { family: 'keys', prefer: [lowLevel, lowLevel === 'keysOrgan' ? 'keysElectronicPiano' : 'keysAcousticPiano'] };
    case 'synths':
      return lowLevel === 'synthsPlucked' ? { family: 'pluckedSynths', prefer: [lowLevel] } : { family: 'pad', prefer: [lowLevel] };
    case 'leadSynths':
      return { family: 'synths', prefer: [lowLevel] };
    case 'basses':
      return { family: 'bass', prefer: [lowLevel] };
    case 'electricGuitars':
    case 'acousticGuitars':
      // A mono sound plays the part of its stereo twin.
      return { family: 'guitar', prefer: [lowLevel, lowLevel.replace(/Mono$/u, 'Stereo')] };
    case 'popStrings':
      return short ? { family: 'popStrings', prefer: [low ? 'popLowStringsStaccato' : 'popHighStringsStaccato'] } : { family: 'pad', prefer: [] };
    case 'popBrass':
      // The generator writes brass only as short phrase-end fills, too sparse
      // for a demo: staccato brass plays the staccato string part, legato
      // brass the pad's held chords.
      return short ? { family: 'popStrings', prefer: ['popHighStringsStaccato'] } : { family: 'pad', prefer: [] };
    case 'orchestral':
      // No genre writes orchestral parts: they borrow the staccato string,
      // pad or bass part that fits their articulation (hits play staccato).
      if (short) return { family: 'popStrings', prefer: [low ? 'popLowStringsStaccato' : 'popHighStringsStaccato'] };
      if (/Bass(Legato|Solo)$/u.test(lowLevel)) return { family: 'bass', prefer: ['bassesAcoustic'] };
      return { family: 'pad', prefer: [] };
    default:
      throw new Error(`donorKind: no generator family plays "${family}" sounds`);
  }
}

/** Which generator family / genre can play each tonal sound (drum kits are audio). */
function buildPatternMap(): Map<string, { family: InstrumentFamily; genres: string[] }> {
  const out = new Map<string, { family: InstrumentFamily; genres: string[] }>();
  for (const family of InstrumentFamilySchema.options) {
    if (family === 'drums') continue;
    for (const genre of GenreSchema.options) {
      for (const e of familySoundPool(family, genre)) {
        const cur = out.get(e.id);
        if (!cur) out.set(e.id, { family, genres: [genre] });
        else if (cur.family === family && !cur.genres.includes(genre)) cur.genres.push(genre);
      }
    }
  }
  return out;
}

export function soundCatalog(): Built {
  if (built) return built;
  const snapshot = loadEffectiveCatalogSnapshot();
  const validated = loadValidatedCatalog();
  const pools = buildPatternMap();
  const patternOf = new Map<string, PatternPreview>();
  // Donor candidates per generator family: sounds a genre uses, with their genres.
  const donors = new Map<InstrumentFamily, { id: string; lowLevel: string; genres: readonly string[] }[]>();
  for (const [id, p] of pools) {
    const v = validated.byId.get(id);
    if (!v) continue;
    const list = donors.get(p.family) ?? [];
    list.push({ id, lowLevel: v.lowLevel, genres: p.genres });
    donors.set(p.family, list);
  }
  for (const list of donors.values()) list.sort((a, b) => a.id.localeCompare(b.id));
  // Genres that write parts for each track kind (in the schema's order).
  const familyGenres = new Map<InstrumentFamily, string[]>();
  for (const [family, list] of donors) {
    const set = new Set(list.flatMap((d) => d.genres));
    familyGenres.set(family, GenreSchema.options.filter((g) => set.has(g)));
  }
  const drumOf = new Map<string, { roles: readonly DrumRole[]; genres: readonly string[]; entry: ValidatedCatalogEntry }>();
  const sampleOf = new Map<string, { plan: SamplePlan; entry: ValidatedCatalogEntry }>();
  const noPreview = new Map<string, string>();
  const items: SoundItem[] = [];
  for (const e of snapshot.entries) {
    const fam = FAMILY_BY_ID.get(e.family);
    if (!fam) continue;
    let preview: SoundPreview = 'none';
    const sampled = (entry: ValidatedCatalogEntry) => {
      const plan = samplePlanFor(entry);
      if (typeof plan === 'string') noPreview.set(e.id, plan);
      else {
        sampleOf.set(e.id, { plan, entry });
        preview = 'sample';
      }
    };
    if (!validated.byId.has(e.id)) noPreview.set(e.id, 'its file is missing from the library');
    if (fam.group === 'Instruments') {
      const entry = validated.byId.get(e.id);
      if (entry && e.lowLevel === 'bassesSynthWobble') {
        // Wobble basses are tempo loops ("… - 120"), not playable notes:
        // the engine plays them as a loop at their tempo.
        sampled(entry);
      } else if (entry) {
        // A sound a track kind can use gets its own part generated (in any
        // genre that writes that kind). Brass (whose generated parts are
        // sparse fills) and orchestral sounds borrow a part (see donorKind).
        const own = userSoundFamily(entry);
        let family: InstrumentFamily;
        let donorId: string;
        if (own && own !== 'popBrass') {
          family = own;
          donorId = e.id;
        } else {
          const kind = donorKind(e.family, e.lowLevel);
          const list = donors.get(kind.family);
          if (!list?.length) throw new Error(`soundCatalog: no genre uses any ${kind.family} sound to lend its part to ${e.id}`);
          family = kind.family;
          donorId = (kind.prefer.map((l) => list.find((d) => d.lowLevel === l)).find(Boolean) ?? list.find((d) => validated.byId.get(d.id)?.family === e.family) ?? list[0]!).id;
        }
        const all = familyGenres.get(family);
        if (!all?.length) throw new Error(`soundCatalog: no genre writes ${family} parts (for ${e.id})`);
        // The sound's own style first, then the rest.
        const genres = e.mainStyle && all.includes(e.mainStyle) ? [e.mainStyle, ...all.filter((g) => g !== e.mainStyle)] : all;
        preview = 'pattern';
        patternOf.set(e.id, { family, genres, donorId, entry });
      }
    } else {
      const entry = validated.byId.get(e.id);
      const roles = entry ? drumPreviewRoles(e.family) : [];
      if (entry && roles.length > 0) {
        drumOf.set(e.id, { roles, genres: drumPreviewGenres(e.mainStyle ?? null), entry });
        preview = 'sample'; // heard on its own, once (not in a groove)
      } else if (entry) {
        sampled(entry);
      }
    }
    items.push({
      id: e.id,
      name: publicNameOf(e),
      family: e.family,
      familyLabel: fam.label,
      type: typeLabel(e.family, e.lowLevel, fam.label),
      styles: [...(e.mainStyle ? [e.mainStyle] : []), ...e.addStyles.filter((s) => s !== e.mainStyle)],
      bpm: e.bpm ?? null,
      key: e.key ?? null,
      preview,
      useAs: validated.byId.has(e.id) ? (userSoundFamily(e) ?? null) : null,
      drumRoles: validated.byId.has(e.id) ? drumRolesForFamily(e.family) : [],
    });
  }
  items.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const validatedById = new Map<string, ValidatedCatalogEntry>();
  for (const v of validated.entries) validatedById.set(v.id, v);
  built = { items, byId: new Map(items.map((i) => [i.id, i])), patternOf, validated: validatedById, drumOf, sampleOf, noPreview };
  return built;
}

/** Transition types whose sound can be chosen, with how many sounds each has (Sounds page). */
export function soundTransitions(): { type: string; label: string; count: number }[] {
  const catalog = loadValidatedCatalog();
  const known = soundCatalog().byId;
  return TRANSITION_TYPES.filter((t) => isSwappableTransition(t.type)).map((t) => ({
    type: t.type,
    label: t.label,
    count: transitionSoundChoices(catalog, t.type).filter((e) => known.has(e.id)).length,
  }));
}

export function soundFamilies(): SoundFamily[] {
  const counts = new Map<string, number>();
  for (const i of soundCatalog().items) counts.set(i.family, (counts.get(i.family) ?? 0) + 1);
  return FAMILIES.map((f) => ({ ...f, count: counts.get(f.id) ?? 0 }));
}

export function searchSounds(q: {
  family?: string;
  useAs?: string;
  transition?: string;
  q?: string;
  style?: string;
  /** The sounds that suit a song in this style, by the generator's own rule:
   *  the ones tagged with the style, or all of them when none is tagged. */
  suits?: string;
  cursor: number;
  limit: number;
}): {
  total: number;
  items: SoundItem[];
  nextCursor: number | null;
  /** With `suits`: none of the sounds is tagged with that style, so all suit it. */
  noneTagged?: boolean;
} {
  if (q.family !== undefined && !FAMILY_BY_ID.has(q.family)) throw new SoundError(400, 'unknown_family', `Unknown sound family "${q.family}".`);
  if (q.useAs !== undefined && !(InstrumentFamilySchema.options as readonly string[]).includes(q.useAs)) {
    throw new SoundError(400, 'unknown_track_kind', `Unknown track kind "${q.useAs}".`);
  }
  // Sounds a transition can play: one per recording, or one per pack for tonal
  // reverses and percussion fills / build-ups (see @casperaki/arrangement
  // transitions/sound.ts).
  let transitionIds: ReadonlySet<string> | undefined;
  if (q.transition !== undefined) {
    if (!isSwappableTransition(q.transition)) throw new SoundError(400, 'not_swappable', `Transition "${q.transition}" has no sounds to choose from.`);
    transitionIds = new Set(transitionSoundChoices(loadValidatedCatalog(), q.transition).map((e) => e.id));
  }
  const text = q.q?.trim().toLowerCase();
  const style = q.style?.trim();
  let base = soundCatalog().items.filter(
    (i) =>
      (q.family === undefined || i.family === q.family) &&
      (q.useAs === undefined || i.useAs === q.useAs) &&
      (transitionIds === undefined || transitionIds.has(i.id)),
  );
  // Decided on the whole source (not the search text), so typing does not change it.
  let noneTagged: boolean | undefined;
  if (q.suits !== undefined) {
    const tagged = base.filter((i) => i.styles.includes(q.suits!));
    noneTagged = tagged.length === 0;
    if (!noneTagged) base = tagged;
  }
  const matches = base.filter(
    (i) =>
      (!style || i.styles.includes(style)) &&
      (!text || i.name.toLowerCase().includes(text) || i.type.toLowerCase().includes(text) || i.styles.some((s) => s.toLowerCase().includes(text))),
  );
  const items = matches.slice(q.cursor, q.cursor + q.limit);
  const next = q.cursor + q.limit;
  return { total: matches.length, items, nextCursor: next < matches.length ? next : null, ...(noneTagged !== undefined ? { noneTagged } : {}) };
}

export class SoundError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// Catalog → disk folder names. The audit matched files under the catalog's
// low-level names; a few folders on disk are named differently (loop bpm bins
// 120-150 → 120-160, 60-89 → 50-89; arcade fx under fxOther). The audit records
// each pair (LEGACY_PROVENANCE.aliasesApplied); the playback pipeline
// (emit-brain-roundtrip.mjs resolveDiskPath) applies the same translation.
const AUDIT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../packages/arrangement/data/sample-library.audit.json');
let aliases: ReadonlyMap<string, string> | undefined;

function diskAliases(): ReadonlyMap<string, string> {
  if (aliases) return aliases;
  const audit = JSON.parse(readFileSync(AUDIT_PATH, 'utf8')) as {
    LEGACY_PROVENANCE?: { aliasesApplied?: { catalogLowLevel: string; diskLowLevel: string }[] };
  };
  const list = audit.LEGACY_PROVENANCE?.aliasesApplied;
  if (!list) throw new Error(`${AUDIT_PATH} has no LEGACY_PROVENANCE.aliasesApplied`);
  aliases = new Map(list.map((a) => [a.catalogLowLevel, a.diskLowLevel]));
  return aliases;
}

/** The library-relative path on disk of a catalog matched path (folder and file name translated). */
export function diskPathOf(matchedPath: string): string {
  const parts = matchedPath.split('/');
  if (parts.length < 3) return matchedPath;
  const [family, lowLevel, ...rest] = parts;
  const disk = diskAliases().get(lowLevel!);
  if (!disk || disk === lowLevel) return matchedPath;
  return `${family}/${disk}/${rest.join('/').split(lowLevel!).join(disk)}`;
}
