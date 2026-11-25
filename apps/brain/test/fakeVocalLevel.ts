// A vocal level for test brains without per-song rendering: the vocals 1 dB under the approved balance, so the fader
// goes up a little. The real one renders the song (src/sing/vocalLevel.ts, tested in vocal-level.spec.ts).
import type { CreateAppDeps } from '../src/bootstrap.js';
import { faderFor } from '../src/sing/vocalLevel.js';

export const FAKE_LEVEL = { vocalsLufs: -13, backingLufs: -12, faderDb: faderFor(-13, -12) };

export function fakeVocalLevel(): NonNullable<CreateAppDeps['vocalLevel']> {
  return {
    levelVocals: async () => FAKE_LEVEL,
    withVocalFader: (overrides, faderDb) => ({
      lanes: overrides?.lanes ?? {},
      buses: { ...(overrides?.buses ?? {}), vocals: { '4': [0.5 * 10 ** (faderDb / 40)] } },
    }),
  };
}
