import { describe, expect, it } from 'vitest';

import type { LaneMeters, ResolvedMixLane } from '../src/audio/livePlayer';
import { buildConsoleBody } from '../src/editor/consoleVideoData';
import type { SequencerModel, SeqTrack } from '../src/editor/sequencerModel';

const part = (lane: string, extra: Partial<ResolvedMixLane> = {}): ResolvedMixLane => ({
  lane,
  track: lane,
  lowLevelType: 'synth',
  fxGroup: 'synths',
  volumeDb: -6,
  sendsDb: { reverb: null, delay: null, chorus: null },
  ...extra,
});

const track = (name: string, extra: Partial<SeqTrack> = {}): SeqTrack => ({
  name,
  color: '#112233',
  isDrums: false,
  isVocal: false,
  clips: [],
  pitchRange: null,
  ...extra,
});

const model: SequencerModel = {
  totalBars: 8,
  sections: [
    { name: 'verse', kind: 'verse', startBar: 0, bars: 4, color: '#000', chordsByBar: [] },
    { name: 'chorus', kind: 'chorus', startBar: 4, bars: 4, color: '#000', chordsByBar: [] },
  ],
  tracks: [
    track('Bass', {
      clips: [{ section: 1, startBar: 4, bars: 2, notes: [{ start: 17, length: 1, pitch: 40, kind: 'note', velocity: 90 }] }],
    }),
    track('Vocal', { isVocal: true, clips: [{ section: 0, startBar: 0, bars: 4, notes: [{ start: 2, length: 2, pitch: 64, kind: 'note', label: 'la' }] }] }),
  ],
};

const meters = (over: Partial<LaneMeters> = {}): LaneMeters => ({
  names: ['Bass', 'Vocal', 'Vocal wet', 'Riser'],
  binSec: 0.5,
  binCount: 3,
  doneBins: 3,
  peaks: [new Float32Array([0.1, 0.2, 0.3]), new Float32Array([0.5, 0, 0]), new Float32Array([0, 0.6, 0.1]), new Float32Array([0, 0, 0.4])],
  busPeaks: [new Float32Array(3), new Float32Array(3), new Float32Array(3), new Float32Array([0.7, 0.8, 0.9])],
  done: true,
  versionKey: '0123456789abcdef',
  mix: {
    mixEnabled: true,
    genre: 'brightPop',
    config: { constants: { masterVolumeDb: 0 }, rackChains: [] },
    lanes: [
      part('Bass', { fxGroup: 'bass', volume: { t0: 0, step: 1, values: [-10, 0] } }),
      part('Vocal', { fxGroup: 'vocals', volumeDb: -3 }),
      part('Vocal wet', { fxGroup: 'vocals', volumeDb: -9, lowPass: { t0: 0, step: 1, values: [500, 20000] } }),
      part('Riser', { fxGroup: 'fx', volumeDb: -10 }),
    ],
  },
  ...over,
});

const args = (m = meters()) => ({ model, meters: m, secondsPerBar: 2, leadVocal: 'Vocal', hex: (css: string) => css });

describe('buildConsoleBody', () => {
  it("makes one strip of a vocal track and its wet lane, the louder of both per bin", () => {
    const body = buildConsoleBody(args());
    const vocal = body.tracks.find((t) => t.name === 'Vocal')!;
    expect(vocal.levels).toEqual([0.5, 0.6, 0.1].map((v) => Math.fround(v)).map((v) => Number(v.toFixed(4))));
    expect(body.tracks.map((t) => t.name)).toEqual(['Bass', 'Vocal', 'Riser']);
  });

  it('follows the mixer: mixed target volumes give null, automation from the first part that has it', () => {
    const body = buildConsoleBody(args());
    const vocal = body.tracks.find((t) => t.name === 'Vocal')!;
    expect(vocal.volumeDb).toBeNull();
    expect(vocal.lowPassAutomation).toEqual({ t0: 0, step: 1, values: [500, 20000] });
    const bass = body.tracks.find((t) => t.name === 'Bass')!;
    expect(bass.volumeDb).toBe(-6);
    expect(bass.volumeAutomation).toEqual({ t0: 0, step: 1, values: [-10, 0] });
    expect(bass.bus).toBe('bass');
  });

  it('makes a lane with no track row an effects strip without a colour', () => {
    const riser = buildConsoleBody(args()).tracks.find((t) => t.name === 'Riser')!;
    expect(riser.role).toBe('effects');
    expect(riser.color).toBeUndefined();
    expect(riser.clips).toEqual([]);
  });

  it('gives the lead vocal its role', () => {
    const body = buildConsoleBody(args());
    expect(body.tracks.find((t) => t.name === 'Vocal')!.role).toBe('leadVocal');
    expect(body.tracks.find((t) => t.name === 'Bass')!.role).toBe('track');
  });

  it('turns bars and beats into seconds', () => {
    const bass = buildConsoleBody(args()).tracks.find((t) => t.name === 'Bass')!;
    expect(bass.clips[0]).toMatchObject({ section: 'chorus', startSeconds: 8, endSeconds: 12 });
    expect(bass.clips[0]!.notes[0]).toEqual({ startSeconds: 8.5, lengthSeconds: 0.5, pitch: 40, velocity: 90 });
    const vocal = buildConsoleBody(args()).tracks.find((t) => t.name === 'Vocal')!;
    expect(vocal.clips[0]!.notes[0]!.velocity).toBeNull();
  });

  it('carries the master, the bin size and the version key', () => {
    const body = buildConsoleBody(args());
    expect(body.master).toEqual([0.7, 0.8, 0.9].map((v) => Number(Math.fround(v).toFixed(4))));
    expect(body.binSeconds).toBe(0.5);
    expect(body.versionKey).toBe('0123456789abcdef');
  });

  it('refuses levels that are not finished measuring', () => {
    expect(() => buildConsoleBody(args(meters({ done: false, doneBins: 1 })))).toThrow(/not finished/);
  });

  it("refuses a track colour that doesn't resolve", () => {
    expect(() =>
      buildConsoleBody({ ...args(), hex: () => { throw new Error('CSS colour --x is not defined'); } }),
    ).toThrow(/not defined/);
  });
});
