import { describe, expect, it } from 'vitest';
import { Midi } from '@tonejs/midi';
import { parseMidi } from 'midi-file';

import { buildSongMidi, instrumentOf } from '../src/export/midi';

const events = {
  tempo: 128,
  tracks: [
    { name: 'Drums-kicks', notes: [], hits: [{ drum: 'bassDrum1', start: 0, velocity: 127 }, { drum: 'bassDrum1', start: 1, velocity: 100 }] },
    { name: 'Drums-rest', notes: [], hits: [{ drum: 'hiHatClosed1', start: 0.5, velocity: 90 }] },
    { name: 'Bass(long notes)', notes: [{ pitch: 36, start: 0, length: 2, velocity: 110, track: 'Bass(long notes)' }], hits: [] },
    { name: 'Bass(short notes)', notes: [{ pitch: 43, start: 2, length: 0.5, velocity: 90, track: 'Bass(short notes)' }], hits: [] },
    { name: 'Keys', notes: [{ pitch: 60, start: 4, length: 1, velocity: 64, track: 'Keys' }], hits: [] },
    { name: 'Loop', notes: [], hits: [] },
  ],
};
const info = {
  title: 'Test',
  key: 'Am',
  instruments: ['Drums', 'Bass', 'Keys', 'Loop'],
  sections: [{ name: 'intro', startBar: 0 }, { name: 'verse1', startBar: 4 }],
};

describe('MIDI export', () => {
  it('groups engine tracks by instrument', () => {
    expect(instrumentOf('Drums-kicks', info.instruments)).toBe('Drums');
    expect(instrumentOf('Bass(short notes)', info.instruments)).toBe('Bass');
    expect(instrumentOf('Synths 2', ['Synths', 'Synths 2'])).toBe('Synths 2');
    expect(instrumentOf('Sample Transitions FX', info.instruments)).toBeUndefined();
  });

  it('writes a type-1 file: tempo, key, markers, one track per instrument, drums on channel 10', () => {
    const midi = new Midi(buildSongMidi(events, info));
    expect(Math.round(midi.header.tempos[0]!.bpm)).toBe(128);
    // A minor: no sharps or flats, minor (read back with the low-level parser).
    const raw = parseMidi(buildSongMidi(events, info)).tracks[0]!.find((e) => e.type === 'keySignature');
    expect(raw).toMatchObject({ key: 0, scale: 1 });
    expect(parseMidi(buildSongMidi(events, { ...info, key: 'Eb' })).tracks[0]!.find((e) => e.type === 'keySignature')).toMatchObject({ key: -3, scale: 0 });
    expect(midi.header.meta.filter((m) => m.type === 'marker').map((m) => [m.text, m.ticks])).toEqual([
      ['intro', 0],
      ['verse1', 4 * 4 * midi.header.ppq],
    ]);
    expect(midi.tracks.map((t) => t.name)).toEqual(['Drums', 'Bass', 'Keys']);
    const [drums, bass, keys] = midi.tracks;
    expect(drums!.channel).toBe(9);
    expect(drums!.notes.map((n) => n.midi).sort()).toEqual([36, 36, 42]);
    expect(bass!.notes.map((n) => [n.midi, n.ticks / midi.header.ppq])).toEqual([
      [36, 0],
      [43, 2],
    ]);
    expect(keys!.notes[0]!.ticks).toBe(4 * midi.header.ppq);
    expect(keys!.channel).not.toBe(9);
  });
});
