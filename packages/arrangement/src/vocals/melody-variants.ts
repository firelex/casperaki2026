// New melodies (Change melody): generator params `melodyVariants`, section type → variant number. `writeVocals`
// picks that type's melody from its own stream `vocals/melody/<type>#v<n>` (see vocals/index.ts).

import { z } from 'zod';

export const MELODY_VARIANTS_PARAM = 'melodyVariants';
export const MelodyVariantsSchema = z.record(z.string().min(1), z.number().int().positive());
export type MelodyVariants = z.infer<typeof MelodyVariantsSchema>;

/** The melody variants in generator params (none when the key is absent). */
export function melodyVariantsOf(params: Readonly<Record<string, unknown>> | undefined): MelodyVariants {
  const raw = params?.[MELODY_VARIANTS_PARAM];
  if (raw === undefined) return {};
  return MelodyVariantsSchema.parse(raw);
}
