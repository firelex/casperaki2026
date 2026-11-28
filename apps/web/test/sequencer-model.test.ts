import { describe, expect, it } from 'vitest';

import { buildSequencerModel, noteToMidi } from '../src/editor/sequencerModel';
import { makeFixtureSong } from './fixture';

describe('sequencer model', () => {
  it('lays sections end to end and places clips at their section', () => {
    const { song } = makeFixtureSong();
    const m = buildSequencerModel(song);
    let bar = 0;
    for (const s of m.sections) {
      expect(s.startBar).toBe(bar);
      bar += s.bars;
    }
    expect(m.totalBars).toBe(bar);
    for (const t of m.tracks) {
      for (const c of t.clips) {
        const sec = m.sections[c.section]!;
        expect(c.startBar).toBe(sec.startBar);
        for (const n of c.notes) {
          expect(n.start).toBeGreaterThanOrEqual(sec.startBar * 4);
          expect(n.start).toBeLessThan((sec.startBar + sec.bars) * 4);
        }
      }
    }
  });

  it('shows an instrument switched on without a written part (a percussion loop) as empty clips in those sections', () => {
    const { song } = makeFixtureSong();
    const [first, second] = song.songStructure.map((s) => s.name);
    const withLoop = {
      ...song,
      arrangement: Object.fromEntries(
        Object.entries(song.arrangement).map(([name, p]) => [name, { ...p, instruments: { ...p.instruments, Loop: name === first } }]),
      ),
    };
    const loop = buildSequencerModel(withLoop).tracks.find((t) => t.name === 'Loop');
    expect(loop).toBeDefined();
    const m = buildSequencerModel(withLoop);
    expect(loop!.clips.map((c) => m.sections[c.section]!.name)).toEqual([first]);
    expect(loop!.clips[0]!.notes).toEqual([]);
    expect(second).toBeDefined();
  });

  it('reads note names and MIDI numbers', () => {
    expect(noteToMidi(60)).toBe(60);
    expect(noteToMidi('C4')).toBe(60);
    expect(noteToMidi('A#2')).toBe(46);
    expect(noteToMidi('Bb2')).toBe(46);
    expect(noteToMidi('nope')).toBeNull();
  });
});

describe('chord pitches', () => {
  it('reads triads, sevenths and suspended chords', async () => {
    const { chordPitches } = await import('../src/editor/sequencerModel');
    expect(chordPitches('C')).toEqual([60, 64, 67]);
    expect(chordPitches('Am')).toEqual([69, 72, 76]);
    expect(chordPitches('Am', 'oneOctaveLow')).toEqual([57, 60, 64]);
    expect(chordPitches('Cmaj7')).toEqual([60, 64, 67, 71]);
    expect(chordPitches('G7')).toEqual([67, 71, 74, 77]);
    expect(chordPitches('Dsus4')).toEqual([62, 67, 69]);
    expect(chordPitches('Bb')).toEqual([70, 74, 77]);
    expect(chordPitches('?')).toBeNull();
  });
});

describe('drum bar pattern', () => {
  it('takes each drum from the first bar that plays it, on the 32nd grid', async () => {
    const { drumBarPattern } = await import('../src/editor/sequencer/ClipDetail');
    const n = (start: number, pitch: number) => ({ start, length: 0.25, pitch, kind: 'note' as const });
    const p = drumBarPattern([n(0, 36), n(2, 36), n(4.5, 36), n(5, 38), n(5.375, 42)], 2);
    expect([...p.get(36)!]).toEqual([0, 16]);
    expect([...p.get(38)!]).toEqual([8]);
    expect([...p.get(42)!]).toEqual([11]);
  });
});

describe('track order', () => {
  it('puts the lead vocal first and the backing vocals next', () => {
    const m = buildSequencerModel(makeFixtureSong().song);
    const names = m.tracks.map((t) => t.name);
    const vocal = names.filter((n) => /vocal/i.test(n));
    expect(vocal.length).toBeGreaterThan(0);
    expect(names.slice(0, vocal.length)).toEqual(vocal);
    expect(/backing/i.test(names[0]!)).toBe(false);
    expect(m.tracks.filter((t) => t.isVocal).map((t) => t.name)).toEqual(vocal);
  });
});

describe('muted clips (docs/superpowers/specs/2026-11-28-rap-like-singing-design.md)', () => {
  it('a section whose takes are all muted is still shown, marked muted; one with a playing take is not', () => {
    const { song } = makeFixtureSong();
    const [first, second] = song.songStructure.map((s) => s.name) as [string, string];
    const take = (segment: string, n: string, muted?: boolean) => ({
      id: `ace-step-conditioned:${segment}:Rap:${n}`, kind: 'ace-step-conditioned', modelId: 'ace', modelVersion: 'repaint',
      output: { uri: `vocal-take:${n.repeat(64)}.ogg`, sha256: n.repeat(64), durationSeconds: 8 },
      attachedTo: { scope: 'segment', segment, instrument: 'Rap' }, ...(muted ? { muted: true } : {}),
    });
    const withTakes = { ...song, aiArtifacts: [take(first, 'a', true), take(second, 'b')] } as typeof song;
    const rap = buildSequencerModel(withTakes).tracks.find((t) => t.name === 'Rap')!;
    expect(rap.clips.map((c) => [c.section, c.muted ?? false])).toEqual([[0, true], [1, false]]);
  });
});
