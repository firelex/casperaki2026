// Recorded sequencer track edits (generator params `trackEdits`) and how
// orchestrate applies them to the instrument selection. See track-edits.ts.

import { z } from 'zod';

import type { GenerateParams } from '../context.js';
import { familySoundPool } from '../selection/index.js';
import { InstrumentFamilySchema, type InstrumentFamily, type SelectionResult } from '../selection/types.js';

// ---- recorded edits (generator params) ----------------------------------------

export const RecordedTrackEditSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('changeSound'), track: z.string().min(1), soundId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('newPattern'), track: z.string().min(1), variant: z.number().int().positive() }).strict(),
  z
    .object({
      kind: z.literal('addTrack'),
      track: z.string().min(1),
      family: InstrumentFamilySchema,
      soundId: z.string().min(1),
      /** Sections (generator names) the lane plays in. */
      segments: z.array(z.string().min(1)).min(1),
    })
    .strict(),
]);
export type RecordedTrackEdit = z.infer<typeof RecordedTrackEditSchema>;
export const RecordedTrackEditsSchema = z.array(RecordedTrackEditSchema);

export const TRACK_EDITS_PARAM = 'trackEdits';

/** The recorded edits in generator params (none when the key is absent). */
export function recordedTrackEdits(params: GenerateParams['params']): RecordedTrackEdit[] {
  const raw = params?.[TRACK_EDITS_PARAM];
  if (raw === undefined) return [];
  return RecordedTrackEditsSchema.parse(raw);
}

/**
 * Apply recorded edits to a selection (pure). Returns the edited selection and
 * the per-lane pattern variations for `generatePatterns`.
 */
export function applyTrackEditsToSelection(
  selection: SelectionResult,
  edits: readonly RecordedTrackEdit[],
  genre: string,
): { selection: SelectionResult; laneVariants: Map<string, number> } {
  let instruments = [...selection.instruments];
  let segments = selection.segments.map((s) => ({ ...s, activeLanes: [...s.activeLanes] }));
  const laneVariants = new Map<string, number>();
  const laneOf = (track: string) => {
    const lane = instruments.find((i) => i.lane === track);
    if (!lane) throw new Error(`trackEdits: no generated track "${track}"`);
    return lane;
  };
  const entryOf = (family: InstrumentFamily, soundId: string) => {
    const entry = familySoundPool(family, genre).find((e) => e.id === soundId);
    if (!entry) throw new Error(`trackEdits: sound ${soundId} is not a ${family} sound for ${genre}`);
    return entry;
  };
  for (const edit of edits) {
    if (edit.kind === 'changeSound') {
      const lane = laneOf(edit.track);
      const entry = entryOf(lane.family, edit.soundId);
      instruments = instruments.map((i) => (i.lane === edit.track ? { ...i, entry, lowLevel: entry.lowLevel } : i));
    } else if (edit.kind === 'newPattern') {
      laneOf(edit.track);
      laneVariants.set(edit.track, edit.variant);
    } else {
      if (instruments.some((i) => i.lane === edit.track)) throw new Error(`trackEdits: track "${edit.track}" already exists`);
      const entry = entryOf(edit.family, edit.soundId);
      instruments.push({
        lane: edit.track,
        family: edit.family,
        lowLevel: entry.lowLevel,
        entry,
        essential: false,
        perSegment: true,
        pickSource: 'genre',
      });
      for (const name of edit.segments) {
        const seg = segments.find((s) => s.segmentName === name);
        if (!seg) throw new Error(`trackEdits: addTrack "${edit.track}": no section "${name}"`);
        seg.activeLanes.push(edit.track);
      }
      segments = [...segments];
    }
  }
  return { selection: { ...selection, instruments, segments }, laneVariants };
}

