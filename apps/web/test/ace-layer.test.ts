import { describe, expect, it } from 'vitest';

import { sectionKindsOf, selectionBars } from '../src/editor/sequencer/AceLayerDialog';

describe('selectionBars', () => {
  it('names the bars a selection covers, counted from 1 with the end bar included', () => {
    expect(selectionBars({ startBar: 4, endBar: 12 })).toBe('bars 5–12');
    expect(selectionBars({ startBar: 4.5, endBar: 6.25 })).toBe('bars 5–7');
    expect(selectionBars({ startBar: 0, endBar: 1 })).toBe('bar 1');
  });
});

describe('sectionKindsOf', () => {
  it('lists each kind of section once, in order of first appearance', () => {
    expect(sectionKindsOf(['intro', 'verse1', 'preChorus1', 'chorus1', 'verse2', 'chorus2', 'bridge1'])).toEqual(['intro', 'verse', 'preChorus', 'chorus', 'bridge']);
  });
});

describe('finalChoruses (where ad-libs go)', () => {
  it('is the run of choruses that ends the song, an outro aside; none when the song ends otherwise', async () => {
    const { finalChoruses } = await import('@casperaki/song-schema/ace-layer');
    expect(finalChoruses(['intro', 'verse1', 'chorus1', 'bridge1', 'chorus2', 'chorus3'])).toEqual(['chorus2', 'chorus3']);
    expect(finalChoruses(['verse1', 'chorus1', 'bridge1', 'chorus2', 'outro'])).toEqual(['chorus2']);
    expect(finalChoruses(['verse1', 'chorus1', 'bridge1'])).toEqual([]);
  });
});

describe('Add rap vocals (RapDialog)', () => {
  it('names sections as people do, ticks the verses at first, and sends only the words the user wrote', async () => {
    const { defaultRapSections, rapSectionLabel, rapWordsToSend } = await import('../src/editor/sequencer/RapDialog');
    expect(rapSectionLabel('verse2')).toBe('Verse 2');
    expect(rapSectionLabel('preChorus1')).toBe('Pre-chorus 1');
    expect(rapSectionLabel('intro')).toBe('Intro');
    expect(defaultRapSections([{ name: 'intro' }, { name: 'verse1' }, { name: 'chorus1' }, { name: 'verse2' }])).toEqual(['verse1', 'verse2']);
    expect(rapWordsToSend(['verse1', 'verse2'], { verse1: '  a\nb ', verse2: '   ', chorus1: 'not ticked' })).toEqual({ verse1: 'a\nb' });
  });
});
