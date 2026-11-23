import { describe, expect, it } from 'vitest';

import { applyMixOverrides, MixOverridesSchema, pruneMixOverrides } from '../src/schemas/mix-overrides.js';

const BASE = JSON.stringify({
  constants: { masterVolumeDb: -1 },
  rackChains: [{ bus: 'bass', plugins: [{ factory: 'makeConsole8SubIn', params: [] }, { factory: 'makeLogical4', params: [0.1, 0.2, 0.3, 0.4, 1] }] }],
});

describe('mix overrides', () => {
  it('no changes = the standard config, untouched', () => {
    expect(applyMixOverrides(BASE, MixOverridesSchema.parse({}))).toBe(BASE);
  });

  it('writes lane overrides and replaces a plugin\'s parameters', () => {
    const o = MixOverridesSchema.parse({ lanes: { Bass: { volumeDb: -3, reverb: -20 } }, buses: { bass: { '1': [0.5, 0.2, 0.3, 0.4, 1] } } });
    const cfg = JSON.parse(applyMixOverrides(BASE, o));
    expect(cfg.laneOverrides).toEqual({ Bass: { volumeDb: -3, reverb: -20 } });
    expect(cfg.rackChains[0].plugins[1].params).toEqual([0.5, 0.2, 0.3, 0.4, 1]);
    expect(cfg.constants).toEqual({ masterVolumeDb: -1 });
  });

  it('refuses changes for a mix the config does not have', () => {
    const p = (buses: unknown) => applyMixOverrides(BASE, MixOverridesSchema.parse({ buses }));
    expect(() => p({ keys: { '1': [0.5] } })).toThrow(/no bus "keys"/);
    expect(() => p({ bass: { '5': [0.5] } })).toThrow(/no plugin at slot 5/);
    expect(() => p({ bass: { '1': [0.5] } })).toThrow(/has 5 parameters, not 1/);
    expect(() => MixOverridesSchema.parse({ lanes: { Bass: { pan: 0 } } })).toThrow();
    expect(() => MixOverridesSchema.parse({ lanes: { Bass: {} } })).toThrow();
  });

  it('drops lanes a song no longer has', () => {
    const o = MixOverridesSchema.parse({ lanes: { Bass: { volumeDb: -3 }, 'Keys 2': { delay: -10 } } });
    expect(Object.keys(pruneMixOverrides(o, ['Bass', 'Drums']).lanes)).toEqual(['Bass']);
  });
});
