// A short demo for one tonal sound: a 4-bar verse in a genre that uses it,
// with a track of the sound's generator family written for it, keeping only
// that track (no other parts, fills or transitions) so the sound plays alone.

import { editTrack, orchestrate, type InstrumentFamily } from '@casperaki/arrangement';
import { DEFAULT_BPM_BY_GENRE, GenreSchema, parseSong, type Song } from '@casperaki/song-schema';

export const PREVIEW_BARS = 4;
const SECTION = 'verse1';

export function previewSong(soundId: string, family: InstrumentFamily, genre: string): { song: Song; track: string; bpm: number } {
  const g = GenreSchema.parse(genre);
  const bpm = DEFAULT_BPM_BY_GENRE[g];
  const base = orchestrate({
    genre: g,
    key: 'C',
    bpm,
    seed: `sound-preview-${soundId}`,
    params: { structure: [{ name: SECTION, bars: PREVIEW_BARS }] },
  });
  // A new track of the sound's family, written for the section, with this sound.
  const { song, track } = editTrack(base, { kind: 'addTrack', family, segments: [SECTION], soundId });
  const payload = song.arrangement[SECTION];
  const override = payload?.overrides?.[track];
  const hasNotes = override?.bars?.some((b) => Object.keys(b.notes ?? {}).length > 0) ?? false;
  if (!payload || !override || !hasNotes) throw new Error(`the generator wrote no part for ${track} (${family}, ${g}) in the preview`);
  const def = song.instrumentDefinitions.find((d) => d.name === track);
  if (!def) throw new Error(`preview track ${track} has no instrument definition`);
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
