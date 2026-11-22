// The public sound catalog behind the Sounds page: every sound with its public
// name only (never library, preset, file path or other original names), the
// families with counts, and how each sound can be previewed:
//   'pattern' — a tonal sound the generator can use (in some genre's pool):
//               previewed as a short pattern written for it
//   'audio'   — a drum hit, loop / break or fx whose file the audit matched:
//               previewed as its own audio
//   'none'    — neither (e.g. a tonal sound no genre uses)

import {
  familySoundPool,
  InstrumentFamilySchema,
  loadEffectiveCatalogSnapshot,
  loadValidatedCatalog,
  publicNameOf,
  type InstrumentFamily,
  type ValidatedCatalogEntry,
} from '@casperaki/arrangement';
import { GenreSchema } from '@casperaki/song-schema';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type SoundPreview = 'pattern' | 'audio' | 'none';
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
  /** Pattern sounds: the generator family and genre to preview them in. */
  readonly patternOf: ReadonlyMap<string, { family: InstrumentFamily; genre: string }>;
  /** Audio sounds: the validated entry (its matched file). */
  readonly validated: ReadonlyMap<string, ValidatedCatalogEntry>;
}

let built: Built | undefined;

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
  const patternOf = new Map<string, { family: InstrumentFamily; genre: string }>();
  const items: SoundItem[] = [];
  for (const e of snapshot.entries) {
    const fam = FAMILY_BY_ID.get(e.family);
    if (!fam) continue;
    const pool = pools.get(e.id);
    let preview: SoundPreview = 'none';
    if (fam.group === 'Instruments') {
      if (pool) {
        preview = 'pattern';
        const genre = e.mainStyle && pool.genres.includes(e.mainStyle) ? e.mainStyle : pool.genres[0]!;
        patternOf.set(e.id, { family: pool.family, genre });
      }
    } else if (validated.byId.has(e.id)) {
      preview = 'audio';
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
    });
  }
  items.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const validatedById = new Map<string, ValidatedCatalogEntry>();
  for (const v of validated.entries) validatedById.set(v.id, v);
  built = { items, byId: new Map(items.map((i) => [i.id, i])), patternOf, validated: validatedById };
  return built;
}

export function soundFamilies(): SoundFamily[] {
  const counts = new Map<string, number>();
  for (const i of soundCatalog().items) counts.set(i.family, (counts.get(i.family) ?? 0) + 1);
  return FAMILIES.map((f) => ({ ...f, count: counts.get(f.id) ?? 0 }));
}

export function searchSounds(q: { family?: string; q?: string; style?: string; cursor: number; limit: number }): {
  total: number;
  items: SoundItem[];
  nextCursor: number | null;
} {
  if (q.family !== undefined && !FAMILY_BY_ID.has(q.family)) throw new SoundError(400, 'unknown_family', `Unknown sound family "${q.family}".`);
  const text = q.q?.trim().toLowerCase();
  const style = q.style?.trim();
  const matches = soundCatalog().items.filter(
    (i) =>
      (q.family === undefined || i.family === q.family) &&
      (!style || i.styles.includes(style)) &&
      (!text || i.name.toLowerCase().includes(text) || i.type.toLowerCase().includes(text) || i.styles.some((s) => s.toLowerCase().includes(text))),
  );
  const items = matches.slice(q.cursor, q.cursor + q.limit);
  const next = q.cursor + q.limit;
  return { total: matches.length, items, nextCursor: next < matches.length ? next : null };
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
