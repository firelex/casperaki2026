import { describe, expect, it } from 'vitest';

import { automationAt } from '../src/audio/livePlayer';

describe('automationAt', () => {
  const a = { t0: 10, step: 0.5, values: [-48, -24, 0] };
  it('interpolates inside the range and is undefined outside it', () => {
    expect(automationAt(a, 9.9)).toBeUndefined();
    expect(automationAt(a, 10)).toBe(-48);
    expect(automationAt(a, 10.25)).toBe(-36);
    expect(automationAt(a, 11)).toBe(0);
    expect(automationAt(a, 11.1)).toBeUndefined();
    expect(automationAt(undefined, 10)).toBeUndefined();
  });
});
