import { describe, expect, it } from 'vitest';

import { selectionBars } from '../src/editor/sequencer/AceLayerDialog';

describe('selectionBars', () => {
  it('names the bars a selection covers, counted from 1 with the end bar included', () => {
    expect(selectionBars({ startBar: 4, endBar: 12 })).toBe('bars 5–12');
    expect(selectionBars({ startBar: 4.5, endBar: 6.25 })).toBe('bars 5–7');
    expect(selectionBars({ startBar: 0, endBar: 1 })).toBe('bar 1');
  });
});
