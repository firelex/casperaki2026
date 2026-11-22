// A short demo for one tonal sound: a 4-bar verse in a genre that uses it,
// with a track of the sound's generator family written for it, keeping only
// that track (no other parts, fills or transitions) so the sound plays alone.

import { editTrack, instrumentDefinitionFromCatalog, orchestrate, type InstrumentFamily, type ValidatedCatalogEntry } from '@casperaki/arrangement';
import { DEFAULT_BPM_BY_GENRE, GenreSchema, parseSong, type Song } from '@casperaki/song-schema';

export const PREVIEW_BARS = 4;
// Some families play only in choruses (e.g. brass): a verse first, then a chorus.
const SECTIONS = ['verse1', 'chorus1'] as const;

/**
 * `donorId` writes the part (a sound the genre uses); `sound` plays it (the
 * same sound, or one no genre uses that borrows the donor's part).
 */
export function previewSong(
  donorId: string,
  family: InstrumentFamily,
  genres: readonly string[],
  sound: ValidatedCatalogEntry,
  variant = 0,
): { song: Song; track: string; bpm: number; genre: string } {
  // A pattern is generated on the fly: `variant` picks another one (another
  // seed). Not every genre writes a part in a short verse: the first of
  // `genres` (and verse, then chorus) that does is used; none is an error.
  const tried: string[] = [];
  for (const section of SECTIONS) {
    for (const genre of genres) {
      const out = previewIn(donorId, family, genre, section, sound, variant);
      if (out) return { ...out, genre };
      tried.push(`${genre} ${section}`);
    }
  }
  throw new Error(`the generator wrote no ${family} part for ${donorId} in a preview (tried ${tried.join(', ')})`);
}

function previewIn(donorId: string, family: InstrumentFamily, genre: string, SECTION: string, sound: ValidatedCatalogEntry, variant: number): { song: Song; track: string; bpm: number } | undefined {
  const soundId = donorId;
  const g = GenreSchema.parse(genre);
  const bpm = DEFAULT_BPM_BY_GENRE[g];
  const base = orchestrate({
    genre: g,
    key: 'C',
    bpm,
    seed: `sound-preview-${donorId}-${variant}`,
    params: { structure: [{ name: SECTION, bars: PREVIEW_BARS }] },
  });
  // A new track of the sound's family, written for the section, with this sound.
  const { song, track } = editTrack(base, { kind: 'addTrack', family, segments: [SECTION], soundId });
  const payload = song.arrangement[SECTION];
  const override = payload?.overrides?.[track];
  const hasNotes = override?.bars?.some((b) => Object.keys(b.notes ?? {}).length > 0) ?? false;
  if (!payload || !override || !hasNotes) return undefined;
  const donorDef = song.instrumentDefinitions.find((d) => d.name === track);
  if (!donorDef) throw new Error(`preview track ${track} has no instrument definition`);
  // A borrowed part keeps the donor's track kind (the engine picks the
  // instrument type from instrumentGroup; e.g. orchestral strings play as
  // a string track) and plays it with this sound.
  const def =
    sound.id === donorId
      ? donorDef
      : { ...instrumentDefinitionFromCatalog(track, sound), type: donorDef.type, instrumentGroup: donorDef.instrumentGroup };
  const processors = payload.signalProcessors?.[track];
  const only = parseSong({
    ...song,
    arrangement: {
      [SECTION]: {
        ...payload,
        instruments: { [track]: true },
        overrides: { [track]: override },
        fills: {},
        mutes: {},
        transitions: {},
        signalProcessors: processors ? { [track]: processors } : {},
      },
    },
    instrumentDefinitions: [def],
    aiArtifacts: [],
  });
  return { song: only, track, bpm };
}
