// A song version: the saved song text plus the mix config it plays with (Pro-mode changes applied). The browser
// measures track levels for one version; the console video checks it is rendering the same one.

import { describe, expect, it } from 'vitest';

import { applyMixOverrides, type MixOverrides } from '@casperaki/song-schema';

import { songMixConfig, songVersionKey } from '../src/render/songVersion.js';

describe('songVersionKey', () => {
  it('is the same for the same song and mix', () => {
    expect(songVersionKey('{"a":1}', '{"m":1}')).toBe(songVersionKey('{"a":1}', '{"m":1}'));
    expect(songVersionKey('{"a":1}', '{"m":1}')).toMatch(/^[0-9a-f]{16}$/u);
  });
  it('changes with the song text', () => {
    expect(songVersionKey('{"a":1}', '{"m":1}')).not.toBe(songVersionKey('{"a":2}', '{"m":1}'));
  });
  it('changes with the mix config', () => {
    expect(songVersionKey('{"a":1}', '{"m":1}')).not.toBe(songVersionKey('{"a":1}', '{"m":2}'));
  });
  it('does not confuse where the song text ends', () => {
    expect(songVersionKey('ab', 'c')).not.toBe(songVersionKey('a', 'bc'));
  });
});

describe('songMixConfig', () => {
  const base = JSON.stringify({ rackChains: [], lanes: {} });
  it('is undefined for a song on the standard mix', () => {
    expect(songMixConfig({ mixOverrides: null }, () => base)).toBeUndefined();
  });
  it('applies the Pro-mode mix to the standard config', () => {
    const overrides = { lanes: { Bass: { volumeDb: -3 } }, buses: {} } as MixOverrides;
    const applied = songMixConfig({ mixOverrides: overrides }, () => base);
    expect(applied).toBe(applyMixOverrides(base, overrides));
  });
  it('fails when a Pro-mode mix has no mix config to apply to', () => {
    const overrides = { lanes: { Bass: { volumeDb: -3 } }, buses: {} } as MixOverrides;
    expect(() => songMixConfig({ mixOverrides: overrides }, undefined)).toThrow(/CASPERAKI_MIX_CONFIG/);
  });
});
