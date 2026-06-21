import { z } from 'zod';
import { SCHEMA_VERSION } from '../version.js';
import { BpmSchema } from './common.js';
import { ArrangementSchema } from './arrangement.js';
import { SongStructureSchema } from './structure.js';
import { InstrumentDefinitionSchema } from './instrument-def.js';
import { AIArtifactSchema } from './ai-artifact.js';

export const GeneratorBlockSchema = z
  .object({
    name: z.string().optional(),
    version: z.string().optional(),
    seed: z.union([z.number().int(), z.string()]).optional(),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .partial();
export type GeneratorBlock = z.infer<typeof GeneratorBlockSchema>;

// `patterns` is the brain's core-pattern library blob. For v1 we accept it
// verbatim as `unknown` and round-trip it; modelling it fully belongs to
// the music-theory/arrangement packages in Phase 3.
export const PatternsBlobSchema = z.array(z.unknown()).optional();
export type PatternsBlob = z.infer<typeof PatternsBlobSchema>;

export const SongSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),

    title: z.string().optional(),
    key: z.string().min(1),
    bpm: BpmSchema,
    genre: z.string().optional(),
    producer: z.string().optional(),

    songStructure: SongStructureSchema,
    arrangement: ArrangementSchema,
    patterns: PatternsBlobSchema,

    instrumentDefinitions: z.array(InstrumentDefinitionSchema).default([]),
    aiArtifacts: z.array(AIArtifactSchema).default([]),

    generator: GeneratorBlockSchema.optional(),
  })
  // Canonical Song is strict. Adapters absorb unknown fields and report them
  // via diagnostics rather than letting them slip through.
  .strict();
export type Song = z.infer<typeof SongSchema>;
