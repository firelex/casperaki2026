import { z } from 'zod';
import { BarSchema } from './notes.js';

// Per-segment, per-instrument override block (e.g. Bass.bars[].notes).
export const InstrumentOverrideSchema = z
  .object({
    type: z.string().optional(),
    reset: z.boolean().optional(),
    bars: z.array(BarSchema).optional(),
    // Drum-pattern override (32nd-note ASCII grids keyed by drum element).
    pattern: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();
export type InstrumentOverride = z.infer<typeof InstrumentOverrideSchema>;

// Drum fill: nested patternXXX maps with per-element ASCII grids.
export const FillPatternSchema = z.record(z.string(), z.string());
export type FillPattern = z.infer<typeof FillPatternSchema>;

export const FillBlockSchema = z
  .object({
    reset: z.boolean().optional(),
    patterns: z.record(z.string(), FillPatternSchema).optional(),
  })
  .passthrough();
export type FillBlock = z.infer<typeof FillBlockSchema>;

// Signal-processor automation curve point.
export const AutomationPointSchema = z
  .object({
    pointIn32ndNotes: z.number().nonnegative(),
    pointInSeconds: z.number().nonnegative().optional(),
    value: z.number(),
  })
  .passthrough();
export type AutomationPoint = z.infer<typeof AutomationPointSchema>;

// `signalProcessors[instrument]` carries a `type` label plus one or more
// curves keyed by parameter name (`lowPassFilter`, `volume`, etc.).
export const SignalProcessorBlockSchema = z
  .object({
    type: z.string().optional(),
  })
  .catchall(z.union([z.string(), z.array(AutomationPointSchema)]));
export type SignalProcessorBlock = z.infer<typeof SignalProcessorBlockSchema>;

// Transition FX placement.
export const TransitionEntrySchema = z.unknown();
export type TransitionEntry = z.infer<typeof TransitionEntrySchema>;

// Mute regions: opaque for v1 (legacy fixtures rarely set them; brain envelopes vary).
export const MuteEntrySchema = z.unknown();
export type MuteEntry = z.infer<typeof MuteEntrySchema>;

export const SegmentPayloadSchema = z
  .object({
    instruments: z.record(z.string(), z.boolean()).default({}),
    overrides: z.record(z.string(), InstrumentOverrideSchema).default({}),
    fills: z.record(z.string(), FillBlockSchema).default({}),
    mutes: z.record(z.string(), MuteEntrySchema).default({}),
    signalProcessors: z.record(z.string(), SignalProcessorBlockSchema).default({}),
    transitions: z.record(z.string(), TransitionEntrySchema).default({}),
  })
  .passthrough();
export type SegmentPayload = z.infer<typeof SegmentPayloadSchema>;

export const ArrangementSchema = z.record(z.string(), SegmentPayloadSchema);
export type Arrangement = z.infer<typeof ArrangementSchema>;
