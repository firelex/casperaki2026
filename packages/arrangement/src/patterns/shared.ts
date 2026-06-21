// Tiny helpers shared by every family generator.
//
// `addNoteEvent` accepts a raw `beat: number`, formats it via
// `formatBarBeat`, and brands it through `BarBeatSchema` so the key type
// matches the song-schema record shape. Cost is one regex match per
// event — negligible for the slice; benefit is the branded type lines
// up across the boundary.

import { formatBarBeat } from '@casperaki/music-theory';
import { BarBeatSchema } from '@casperaki/song-schema';

import type { BarPattern, NoteEvent } from './types.js';

export function emptyBarPattern(): BarPattern {
  return { notes: {} };
}

export function addNoteEvent(
  bar: BarPattern,
  beat: number,
  event: NoteEvent,
): void {
  const key = BarBeatSchema.parse(formatBarBeat(beat));
  const existing = bar.notes[key];
  if (existing) existing.push(event);
  else bar.notes[key] = [event];
}
