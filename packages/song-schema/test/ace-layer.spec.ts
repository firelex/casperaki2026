import { describe, expect, it } from 'vitest';

import { aceInstrumentOfTrack, aceTrackName, aceTrackOf, rapLineCount } from '../src/ace-layer.js';

describe('rap (ACE layer)', () => {
  it('raps one line per bar, at least one', () => {
    // a line per bar (owner 2026-11-28: 8 lines in an 8-bar verse, "8-line is it")
    expect(rapLineCount(8)).toBe(8);
    expect(rapLineCount(4)).toBe(4);
    expect(rapLineCount(1)).toBe(1);
    expect(() => rapLineCount(0)).toThrow(/0 bars/u);
  });

  it("is rapped on ACE's vocals track, with no voice to choose", () => {
    expect(aceTrackOf('rap', undefined)).toBe('vocals');
    expect(() => aceTrackOf('rap', 'vocals')).toThrow(/no voice/u);
  });

  it('plays on a track "AI Rap" (songs from before keep their "ACE" tracks, still recognised)', () => {
    expect(aceTrackName('rap', ['AI Rap'])).toBe('AI Rap 2');
    expect(aceTrackName('guitar', [])).toBe('AI Guitar');
    expect(aceInstrumentOfTrack('AI Guitar 2')).toBe('guitar');
    expect(aceInstrumentOfTrack('ACE Rap 2')).toBe('rap');
    expect(aceInstrumentOfTrack('Rap')).toBe('rap');
    expect(aceInstrumentOfTrack('Rap 2')).toBeUndefined();
  });
});
