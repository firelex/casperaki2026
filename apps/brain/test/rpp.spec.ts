import { describe, expect, it } from 'vitest';

import { buildRpp } from '../src/export/rpp.js';

describe('buildRpp', () => {
  const rpp = buildRpp({
    title: 'Song',
    bpm: 128,
    lengthSec: 200.5,
    sections: [
      { name: 'intro', startSec: 0, endSec: 7.5 },
      { name: 'verse1', startSec: 7.5, endSec: 22.5 },
    ],
    stems: [
      { name: 'Drums', file: 'Audio/Drums.wav', color: '#ff0000' },
      { name: 'Bass', file: 'Audio/Bass.wav' },
    ],
    midi: [
      { name: 'Drums', file: 'MIDI/Drums.mid' },
      { name: 'Bass', file: 'MIDI/Bass.mid' },
    ],
  });

  it('writes tempo and the sections as regions', () => {
    expect(rpp.startsWith('<REAPER_PROJECT')).toBe(true);
    expect(rpp).toContain('TEMPO 128 4 4');
    expect(rpp).toContain('MARKER 1 0 "intro" 1');
    expect(rpp).toContain('MARKER 1 7.5 "" 1');
    expect(rpp).toContain('MARKER 2 7.5 "verse1" 1');
  });

  it('writes a track per stem with its file, and a muted MIDI folder', () => {
    expect(rpp).toContain('NAME "Drums"');
    expect(rpp).toContain('FILE "Audio/Drums.wav"');
    expect(rpp).toContain('LENGTH 200.5');
    expect(rpp).toContain(`PEAKCOL ${0x01000000 + 0xff}`); // red: R in the low byte
    expect(rpp).toContain('NAME "MIDI (muted)"');
    expect(rpp).toContain('ISBUS 1 1');
    expect(rpp).toContain('<SOURCE MIDI');
    expect(rpp.trimEnd().endsWith('ISBUS 2 -1\n    <ITEM\n      POSITION 0\n      LENGTH 200.5\n      NAME "Bass"\n      <SOURCE MIDI\n        FILE "MIDI/Bass.mid"\n      >\n    >\n  >\n>')).toBe(true);
    // Balanced blocks.
    expect((rpp.match(/</gu) ?? []).length).toBe((rpp.match(/^\s*>\s*$/gmu) ?? []).length);
  });
});
