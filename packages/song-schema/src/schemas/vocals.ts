import { z } from 'zod';

/**
 * Sung vocals (docs/superpowers/specs/2026-11-24-sung-vocals-design.md): whether the lead Vocal track is sung
 * (SoulX-Singer), with which voice, and the take number of each section that was sung again (absent = take 1).
 * Absent on a song = off (songs made before sung vocals). The takes themselves are `aiArtifacts` entries of kind
 * `soulx-vocal` attached to { segment, instrument: 'Vocal' }.
 */
export const VocalsSettingSchema = z
  .object({
    enabled: z.boolean(),
    voice: z.string().min(1),
    takeNumbers: z.record(z.string(), z.number().int().min(1)),
  })
  .strict();
export type VocalsSetting = z.infer<typeof VocalsSettingSchema>;
