import { z } from 'zod';
import { ChordSymbolSchema } from './common.js';

// A bar in the structure carries the chord progression, one entry per beat.
export const StructureBarSchema = z
  .object({
    chords: z.array(ChordSymbolSchema),
  })
  .passthrough();
export type StructureBar = z.infer<typeof StructureBarSchema>;

export const SegmentSchema = z
  .object({
    // Canonical key. Adapters map legacy `segment` (engine) onto this.
    name: z.string().min(1),
    bars: z.array(StructureBarSchema),
    chordStructure: z.string().optional(),
    lengthInBars: z.number().int().positive().optional(),
    precedent: z.string().optional(),
    // High-level type tag the brain attaches (intro / verse / chorus / ...).
    // Kept loose to avoid drift against the legacy genre vocabulary.
    type: z.string().optional(),
  })
  .passthrough();
export type Segment = z.infer<typeof SegmentSchema>;

export const SongStructureSchema = z.array(SegmentSchema);
export type SongStructure = z.infer<typeof SongStructureSchema>;
