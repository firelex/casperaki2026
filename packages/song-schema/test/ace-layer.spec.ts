import { describe, expect, it } from 'vitest';

import { aceInstrumentOfTrack, aceTrackName, aceTrackOf, rapLineCount } from '../src/ace-layer.js';

describe('rap (ACE layer)', () => {
  it('raps one line per two bars, at least one', () => {
    expect(rapLineCount(8)).toBe(4);
    expect(rapLineCount(4)).toBe(2);
    expect(rapLineCount(1)).toBe(1);
    expect(() => rapLineCount(0)).toThrow(/0 bars/u);
  });

  it("is rapped on ACE's vocals track, with no voice to choose", () => {
    expect(aceTrackOf('rap', undefined)).toBe('vocals');
    expect(() => aceTrackOf('rap', 'vocals')).toThrow(/no voice/u);
  });

  it('plays on a track "ACE Rap"', () => {
    expect(aceTrackName('rap', ['ACE Rap'])).toBe('ACE Rap 2');
    expect(aceInstrumentOfTrack('ACE Rap 2')).toBe('rap');
    expect(aceInstrumentOfTrack('Rap')).toBe('rap');
    expect(aceInstrumentOfTrack('Rap 2')).toBeUndefined();
  });
});
