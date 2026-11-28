import { z } from 'zod';
import { LufsSchema, Sha256Schema } from './common.js';

export const AIArtifactKindSchema = z.enum([
  'ace-step-conditioned',
  'soulx-vocal',
  'yue2-vocal',
  'sam-stem',
  'matchering-master',
]);
export type AIArtifactKind = z.infer<typeof AIArtifactKindSchema>;

export const AIArtifactAttachmentSchema = z.union([
  z.object({ scope: z.literal('song') }),
  z.object({
    scope: z.literal('segment'),
    segment: z.string(),
    instrument: z.string().optional(),
  }),
]);
export type AIArtifactAttachment = z.infer<typeof AIArtifactAttachmentSchema>;

export const AIArtifactOutputSchema = z.object({
  uri: z.string(),
  sha256: Sha256Schema,
  lufs: LufsSchema.optional(),
  durationSeconds: z.number().nonnegative().optional(),
});
export type AIArtifactOutput = z.infer<typeof AIArtifactOutputSchema>;

export const AIArtifactSchema = z
  .object({
    id: z.string().min(1),
    kind: AIArtifactKindSchema,
    modelId: z.string(),
    modelVersion: z.string(),
    seed: z.union([z.number().int(), z.string()]).optional(),
    prompt: z.string().optional(),
    adapterVersion: z.string().optional(),
    conditioning: z
      .object({
        renderIds: z.array(z.string()).optional(),
        stemIds: z.array(z.string()).optional(),
        hashes: z.array(Sha256Schema).optional(),
      })
      .partial()
      .optional(),
    output: AIArtifactOutputSchema,
    attachedTo: AIArtifactAttachmentSchema,
    createdAt: z.string().optional(),
    /** Muted by the user or under a rap (docs/superpowers/specs/2026-11-28-rap-like-singing-design.md): shown, but left
     *  out of playback, render and export. Absent when the take plays. */
    muted: z.boolean().optional(),
  })
  .strict();
export type AIArtifact = z.infer<typeof AIArtifactSchema>;
