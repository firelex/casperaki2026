import { z } from 'zod';
import { NoteRefSchema } from './common.js';

// Sample entry in an instrument's `samples` array.
export const InstrumentSampleSchema = z
  .object({
    id: z.union([z.number(), z.string()]),
    // Guitar/strum samples carry `chord` instead of `note`; both null in
    // some web-tester rows. Permit null to preserve legacy fidelity.
    note: NoteRefSchema.nullable().optional(),
    type: z.string().optional(),
    file: z.string().optional(),
    vst: z.union([z.number(), z.string()]).optional(),
    chord: z.string().nullable().optional(),
  })
  .passthrough();
export type InstrumentSample = z.infer<typeof InstrumentSampleSchema>;

// Per-drum-element subInstrument definition (drum kits).
export const SubInstrumentSchema = z
  .object({
    id: z.union([z.number(), z.string()]),
    instrumentGroup: z.string().optional(),
    lowLevelType: z.string().optional(),
    type: z.string().optional(),
    isSample: z.boolean().optional(),
    isVst: z.boolean().optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type SubInstrument = z.infer<typeof SubInstrumentSchema>;

export const InstrumentDefinitionSchema = z
  .object({
    id: z.union([z.number(), z.string()]),
    name: z.string(),
    shortName: z.string().optional(),
    type: z.string().optional(),
    lowLevelType: z.string().optional(),
    instrumentGroup: z.string().optional(),
    isVst: z.boolean().optional(),
    isSample: z.boolean().optional(),
    sampleOrVst: z.string().optional(),
    vstPlugin: z.string().optional(),
    busyness: z.union([z.number(), z.string()]).optional(),
    patternStyle: z.string().optional(),
    details: z.record(z.string(), z.unknown()).optional(),
    samples: z.array(InstrumentSampleSchema).optional(),
    // Drum kits map element name → sample/VST id.
    ids: z.record(z.string(), z.union([z.number(), z.string()])).optional(),
    subInstruments: z.record(z.string(), SubInstrumentSchema).optional(),
    transitionId: z.union([z.number(), z.string()]).optional(),
  })
  .passthrough();
export type InstrumentDefinition = z.infer<typeof InstrumentDefinitionSchema>;
