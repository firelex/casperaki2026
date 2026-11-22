// Add a section to a working song, written by the generator: regenerate the
// song with the working song's sections plus the new one (params.structure),
// then copy only the new section (its bars with chords, and every track's
// part for the tracks the working song has) into the working song. The rest
// of the working song is untouched.

import { orchestrate } from '../orchestrate/index.js';
import { SECTION_TYPES } from '../structure/index.js';
import { parseSong, type Song } from '@casperaki/song-schema';

import { generatorParams, TrackEditError } from './track-edits.js';

/** Default length per section type, in bars. */
const DEFAULT_BARS: Record<(typeof SECTION_TYPES)[number], number> = {
  intro: 4,
  verse: 8,
  preChorus: 4,
  chorus: 8,
  bridge: 8,
  break: 2,
  outro: 8,
};

const TRACK_KEYED = ['instruments', 'overrides', 'fills', 'mutes', 'signalProcessors'] as const;

/** A free section name for `type`: "chorus3" (intro/outro first try without a number). */
export function nextSectionName(type: string, taken: ReadonlySet<string>): string {
  if ((type === 'intro' || type === 'outro') && !taken.has(type)) return type;
  for (let n = 1; ; n++) if (!taken.has(`${type}${n}`)) return `${type}${n}`;
}

export function addSection(working: Song, type: string, index: number, bars?: number): { song: Song; name: string } {
  if (!(SECTION_TYPES as readonly string[]).includes(type)) {
    throw new TrackEditError(400, 'unknown_section_type', `Unknown section type "${type}" (one of ${SECTION_TYPES.join(', ')}).`);
  }
  const length = working.songStructure.length;
  if (!Number.isInteger(index) || index < 0 || index > length) throw new TrackEditError(400, 'bad_index', `Index ${index} is outside 0..${length}.`);
  const sectionBars = bars ?? DEFAULT_BARS[type as (typeof SECTION_TYPES)[number]];
  if (!Number.isInteger(sectionBars) || sectionBars < 1 || sectionBars > 64) throw new TrackEditError(400, 'bad_bars', 'Bars must be 1..64.');

  const params = generatorParams(working);
  const taken = new Set(working.songStructure.map((s) => s.name));
  const name = nextSectionName(type, taken);
  // The generator needs every name to start with a section type: sections the
  // user renamed get stand-in names for the regeneration (only the new one is kept).
  const structure = working.songStructure.map((s, i) => {
    const t = /^[^0-9]+/u.exec(s.name)?.[0] ?? '';
    const valid = (SECTION_TYPES as readonly string[]).includes(t);
    return { name: valid ? s.name : `verse${9000 + i}`, bars: s.lengthInBars ?? s.bars.length };
  });
  structure.splice(index, 0, { name, bars: sectionBars });

  const regenerated = orchestrate({ ...params, params: { ...(params.params ?? {}), structure } });
  const seg = regenerated.songStructure.find((s) => s.name === name);
  const payload = regenerated.arrangement[name];
  if (!seg || !payload) throw new Error(`addSection: the generator wrote no section "${name}"`);

  // Keep only the tracks the working song has.
  const tracks = new Set(working.instrumentDefinitions.map((d) => d.name));
  const filtered: Record<string, unknown> = { ...payload };
  for (const field of TRACK_KEYED) {
    const map = (payload[field] ?? {}) as Record<string, unknown>;
    filtered[field] = Object.fromEntries(Object.entries(map).filter(([k]) => tracks.has(k)));
  }
  filtered.transitions = {};

  const songStructure = [...working.songStructure];
  songStructure.splice(index, 0, seg);
  const song = parseSong({ ...working, songStructure, arrangement: { ...working.arrangement, [name]: filtered } });
  return { song, name };
}
