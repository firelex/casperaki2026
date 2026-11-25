import { describe, expect, it } from 'vitest';

import { profileStoreKey } from '../src/audio/masteringProfileStore';

const payload = { song: '{"bpm":120}', insts: ['{"id":1}', '{"id":2}'], mixConfig: '{"version":1}' };

describe('profileStoreKey', () => {
  it('is the same for the same analysis, so a reload finds the stored profile', async () => {
    expect(await profileStoreKey({ ...payload }, 'v1', 48000)).toBe(await profileStoreKey(payload, 'v1', 48000));
    expect(await profileStoreKey(payload, 'v1', 48000)).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('changes with anything the analysis depends on: the mix, the song, its instruments, the rate, the engine', async () => {
    const base = await profileStoreKey(payload, 'v1', 48000);
    const others = await Promise.all([
      profileStoreKey({ ...payload, mixConfig: '{"version":2}' }, 'v1', 48000),
      profileStoreKey({ ...payload, song: '{"bpm":121}' }, 'v1', 48000),
      profileStoreKey({ ...payload, insts: ['{"id":1}'] }, 'v1', 48000),
      profileStoreKey(payload, 'v1', 44100),
      profileStoreKey(payload, 'v2', 48000),
    ]);
    expect(new Set([base, ...others]).size).toBe(6);
  });
});
