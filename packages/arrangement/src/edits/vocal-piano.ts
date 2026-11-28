// A sung part played on a piano, for previews: the playback engine does not
// sing yet, so the preview window plays the melody (one note per syllable,
// same pitch and length) on an acoustic piano instead.

import { baseGenre, parseSong, type Song } from '@casperaki/song-schema';

import { loadValidatedCatalog, type ValidatedCatalogEntry } from '../catalog/validated-catalog.js';
import { instrumentDefinitionFromCatalog } from '../orchestrate/index.js';
import { familySoundPool } from '../selection/index.js';
import { TrackEditError } from './track-edits.js';
import { LEAD_VOCAL_TRACK } from './vocal-edits.js';

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
  const piano = previewPiano(baseGenre(song.genre));
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

/**
 * The song as playback plays it while its melody has no lyrics (owner 2026-11-28: the piano the detail view plays
 * the vocal on, "over the song with the rest of the instruments"): the lead track, keeping its name (its mixer strip,
 * mute and solo), plays its notes on `previewPiano`, without the vocal effects; everything else as it is. `song`
 * itself when the lead has no notes or any note carries a word (lyrics written: the takes sing it).
 */
export function wordlessMelodyAsPiano(song: Song): Song {
  if (!song.instrumentDefinitions.some((d) => d.name === LEAD_VOCAL_TRACK)) return song;
  let notes = 0;
  for (const payload of Object.values(song.arrangement)) {
    for (const bar of payload.overrides?.[LEAD_VOCAL_TRACK]?.bars ?? []) {
      for (const events of Object.values(bar.notes ?? {})) {
        for (const e of events ?? []) {
          const ev = e as { type: string; fullWord?: string };
          if (ev.type !== 'vocalNote') continue;
          if (ev.fullWord !== undefined) return song;
          notes++;
        }
      }
    }
  }
  if (notes === 0) return song;
  if (!song.genre) throw new Error('wordlessMelodyAsPiano: the song has no style to pick a piano for');
  const piano = previewPiano(baseGenre(song.genre));
  const arrangement: Song['arrangement'] = {};
  for (const [name, payload] of Object.entries(song.arrangement)) {
    const part = payload.overrides?.[LEAD_VOCAL_TRACK];
    if (!part) {
      arrangement[name] = payload;
      continue;
    }
    const bars = (part.bars ?? []).map((bar) => ({
      ...bar,
      notes: Object.fromEntries(
        Object.entries(bar.notes ?? {}).map(([beat, events]) => [
          beat,
          (events ?? []).map((e) => {
            const ev = e as { type: string; note: unknown; duration: number };
            if (ev.type !== 'vocalNote' || typeof ev.note !== 'number') return e;
            return { type: 'note', note: ev.note, duration: ev.duration };
          }),
        ]),
      ),
    }));
    const { [LEAD_VOCAL_TRACK]: _fx, ...signalProcessors } = payload.signalProcessors ?? {};
    arrangement[name] = { ...payload, overrides: { ...payload.overrides, [LEAD_VOCAL_TRACK]: { ...part, bars } }, signalProcessors } as typeof payload;
  }
  const instrumentDefinitions = song.instrumentDefinitions.map((d) => (d.name === LEAD_VOCAL_TRACK ? instrumentDefinitionFromCatalog(LEAD_VOCAL_TRACK, piano) : d));
  return parseSong({ ...song, arrangement, instrumentDefinitions });
}
