// A sung part played on a piano, for previews: the playback engine does not
// sing yet, so the preview window plays the melody (one note per syllable,
// same pitch and length) on an acoustic piano instead.

import { parseSong, type Song } from '@casperaki/song-schema';

import { loadValidatedCatalog, type ValidatedCatalogEntry } from '../catalog/validated-catalog.js';
import { instrumentDefinitionFromCatalog } from '../orchestrate/index.js';
import { familySoundPool } from '../selection/index.js';
import { TrackEditError } from './track-edits.js';

const PIANO = 'keysAcousticPiano';
const LANE = 'Keys';

/** The piano for a song's style: the style's first acoustic piano, else the library's. */
export function previewPiano(genre: string): ValidatedCatalogEntry {
  const byId = (a: ValidatedCatalogEntry, b: ValidatedCatalogEntry) => a.id.localeCompare(b.id);
  const styled = familySoundPool('keys', genre).filter((e) => e.lowLevel === PIANO).sort(byId);
  if (styled[0]) return styled[0];
  const any = loadValidatedCatalog().entries.filter((e) => e.lowLevel === PIANO).sort(byId);
  if (!any[0]) throw new Error('previewPiano: the library has no acoustic piano');
  return any[0];
}

/**
 * `song` (a preview song holding only the sung track `track`) with that track
 * turned into a piano track named "Keys" playing the melody's notes.
 */
export function vocalAsPiano(song: Song, track: string): { song: Song; piano: ValidatedCatalogEntry } {
  if (song.instrumentDefinitions.length !== 1 || song.instrumentDefinitions[0]!.name !== track) {
    throw new TrackEditError(400, 'not_a_preview', `Send a preview song holding only the track "${track}".`);
  }
  if (!song.genre) throw new TrackEditError(400, 'no_genre', 'The song has no style to pick a piano for.');
  const piano = previewPiano(song.genre);
  let notes = 0;
  const arrangement: Song['arrangement'] = {};
  for (const [name, payload] of Object.entries(song.arrangement)) {
    const part = payload.overrides?.[track];
    const bars = (part?.bars ?? []).map((bar) => ({
      notes: Object.fromEntries(
        Object.entries(bar.notes ?? {}).map(([beat, events]) => [
          beat,
          (events ?? []).map((e) => {
            const ev = e as { type: string; note: unknown; duration: number };
            if (ev.type !== 'vocalNote' || typeof ev.note !== 'number') {
              throw new TrackEditError(400, 'not_sung', `${track} in ${name} holds a "${ev.type}" event, not sung notes.`);
            }
            notes++;
            return { type: 'note', note: ev.note, duration: ev.duration };
          }),
        ]),
      ),
    }));
    arrangement[name] = {
      ...payload,
      instruments: { [LANE]: Boolean(part) },
      overrides: part ? { [LANE]: { ...part, bars } } : {},
      signalProcessors: {},
      fills: {},
      mutes: {},
      transitions: {},
    } as typeof payload;
  }
  if (notes === 0) throw new TrackEditError(400, 'no_notes', `${track} has no sung notes here.`);
  const out = parseSong({ ...song, arrangement, instrumentDefinitions: [instrumentDefinitionFromCatalog(LANE, piano)] });
  return { song: out, piano };
}
