// Lyrics first (docs/superpowers/specs/2026-11-27-lyrics-first-singing-design.md): generator params `lyricRhythms`
// (section type → the rhythm recut to its words, recut.ts) and `rhythmVariants` (section type → how many times New
// rhythm drew another; the draw is the stream `vocals/rhythm/<type>#v<n>`). `writeVocals` lays the type's melody on
// its stored recut. Absent: no section is lyrics first (every song before 2026-11-27).

import { z } from 'zod';

import { RecutSchema } from './recut.js';

export const LYRIC_RHYTHMS_PARAM = 'lyricRhythms';
export const LyricRhythmsSchema = z.record(z.string().min(1), RecutSchema);
export type LyricRhythms = z.infer<typeof LyricRhythmsSchema>;

export const RHYTHM_VARIANTS_PARAM = 'rhythmVariants';
export const RhythmVariantsSchema = z.record(z.string().min(1), z.number().int().positive());
export type RhythmVariants = z.infer<typeof RhythmVariantsSchema>;

function parsed<T>(params: Readonly<Record<string, unknown>> | undefined, key: string, schema: z.ZodType<T>, empty: T): T {
  const raw = params?.[key];
  if (raw === undefined) return empty;
  const r = schema.safeParse(raw);
  if (!r.success) throw new Error(`${key}: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return r.data;
}

/** The stored recut rhythms (none when the key is absent). */
export function lyricRhythmsOf(params: Readonly<Record<string, unknown>> | undefined): LyricRhythms {
  return parsed(params, LYRIC_RHYTHMS_PARAM, LyricRhythmsSchema, {});
}

/** The rhythm variants (none when the key is absent). */
export function rhythmVariantsOf(params: Readonly<Record<string, unknown>> | undefined): RhythmVariants {
  return parsed(params, RHYTHM_VARIANTS_PARAM, RhythmVariantsSchema, {});
}
