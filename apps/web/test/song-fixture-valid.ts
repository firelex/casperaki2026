/**
 * Strictly parseSong-valid Song fixture used by editor / reducer tests.
 *
 * The fixture in `./fixture.ts` is a workbench view-helper fixture that
 * casts unsupported branded fields through `as never`; it deliberately
 * skips full parseSong-validity to keep the test surface minimal. The
 * reducer tests need a Song that survives `parseSong(working)` after
 * each mutation, so we build one from scratch here.
 */

import { parseSong, type Song } from '@casperaki/song-schema';

export function makeValidSong(): Song {
  const raw = {
    schemaVersion: '1',
    title: 'Edit Fixture',
    key: 'C',
    bpm: 120,
    genre: 'brightPop',
    songStructure: [
      {
        name: 'intro',
        type: 'intro',
        lengthInBars: 4,
        bars: bars(4, ['C', 'G', 'Am', 'F']),
      },
      {
        name: 'verse1',
        type: 'verse',
        lengthInBars: 8,
        bars: bars(8, ['C', 'F', 'G', 'C']),
      },
      {
        name: 'chorus1',
        type: 'chorus',
        lengthInBars: 8,
        bars: bars(8, ['Am', 'F', 'C', 'G']),
      },
      {
        name: 'outro',
        type: 'outro',
        lengthInBars: 4,
        bars: bars(4, ['C']),
      },
    ],
    arrangement: {
      intro: payload(),
      verse1: payload(),
      chorus1: payload(),
      outro: payload(),
    },
    instrumentDefinitions: [],
    aiArtifacts: [],
    generator: {
      name: 'orchestrate',
      version: '0.0-test',
      seed: 'edit-fixture',
      params: { genre: 'brightPop', key: 'C', bpm: 120 },
    },
  };
  return parseSong(raw);
}

function bars(count: number, chords: readonly string[]) {
  return Array.from({ length: count }, () => ({ chords: [...chords] }));
}

function payload() {
  return {
    instruments: { Drums: true, Bass: true, Keys: true, Pad: false },
    overrides: {},
    fills: {},
    mutes: {},
    signalProcessors: {},
    transitions: {},
  };
}
