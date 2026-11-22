import { describe, expect, it } from 'vitest';

import { DEVICES } from '../src/editor/devices/deviceDefs';

describe('device definitions', () => {
  it('shows values in the plugins own units', () => {
    const eq = DEVICES.makeEQ!;
    expect(eq.params.map((p) => p.name)).toHaveLength(8);
    expect(eq.params[0]!.display(0.5)).toBe('+0.0 dB');
    expect(eq.params[5]!.display(1)).toBe('1600 Hz');
    expect(DEVICES.makeADClip7!.params[3]!.display(0)).toBe('Normal');
    expect(DEVICES.makeFreqShiftEcho!.params[3]!.display(0.2174)).toBe('2.02 beats');
  });
});
