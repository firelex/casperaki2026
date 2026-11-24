import type { GeneratedSong } from '../src/api/songs';

/**
 * Minimal Song fixture for unit tests.
 *
 * Hand-rolled, NOT a captured brain response: the canonical schema
 * accepts more than this, but the workbench view helpers must work with
 * the smallest legal shape (so they degrade gracefully on early-phase
 * Songs that don't yet carry vocals or drum overrides).
 */
export function makeFixtureSong(): GeneratedSong {
  return {
    id: 'abc123def4567890',
    hash: 'a'.repeat(64),
    project: {
      id: 'abc123def4567890',
      title: 'Test Track',
      genre: 'brightPop',
      key: 'C',
      bpm: 120,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      sections: [{ name: 'intro', type: 'intro', bars: 4 }],
      mixOverrides: null,
      mixUpdatedAt: null,
      lyrics: null,
      render: { state: 'none' },
    },
    song: {
      schemaVersion: '1',
      title: 'Test Track',
      key: 'C',
      bpm: 120 as never,
      genre: 'brightPop',
      schemaVersion_marker: undefined,
      songStructure: [
        {
          name: 'intro',
          type: 'intro',
          lengthInBars: 4,
          bars: [
            { chords: ['C' as never, 'G' as never, 'Am' as never, 'F' as never] },
            { chords: ['C' as never, 'G' as never, 'Am' as never, 'F' as never] },
            { chords: ['C' as never, 'G' as never, 'Am' as never, 'F' as never] },
            { chords: ['C' as never, 'G' as never, 'Am' as never, 'F' as never] },
          ],
        },
        {
          name: 'verse1',
          type: 'verse',
          lengthInBars: 8,
          bars: Array.from({ length: 8 }, () => ({
            chords: ['C' as never, 'F' as never, 'G' as never, 'C' as never],
          })),
        },
      ],
      arrangement: {
        intro: {
          instruments: { Drums: true, Bass: true, Keys: true, Pad: false },
          overrides: {
            Drums: {
              type: 'brainRoundtrip',
              pattern: {
                bassDrum1: 'x...x...x...x...',
                snareDrum1: '....x.......x...',
                hiHatClosed1: 'xxxxxxxxxxxxxxxx',
              },
            },
            Bass: {
              type: 'brainRoundtrip',
              bars: [
                {
                  notes: {
                    ['0.0' as never]: [{ type: 'note', note: 'c2' as never, duration: 1 }],
                    ['2.0' as never]: [{ type: 'note', note: 'g2' as never, duration: 1 }],
                  } as never,
                },
              ],
            },
          },
          fills: {},
          mutes: {},
          signalProcessors: {},
          transitions: {},
        },
        verse1: {
          instruments: {
            Drums: true,
            Bass: true,
            Keys: true,
            Pad: true,
            ['Vocal']: true,
            ['Backing vocals 1']: true,
            ['Backing vocals 2']: false,
          },
          overrides: {
            ['Vocal']: {
              type: 'brainVocals',
              bars: [
                {
                  notes: {
                    ['0.0' as never]: [
                      { type: 'vocalNote', note: 'c4' as never, fullWord: 'hello' },
                    ],
                    ['1.0' as never]: [
                      { type: 'vocalNote', note: 'd4' as never, fullWord: 'world', endOfPhrase: true },
                    ],
                  } as never,
                },
              ],
            },
            ['Backing vocals 1']: {
              type: 'brainBackingDouble',
              bars: [
                {
                  notes: {
                    ['0.0' as never]: [
                      { type: 'vocalNote', note: 'e4' as never, fullWord: 'hello' },
                    ],
                  } as never,
                },
              ],
            },
          },
          fills: {
            Drums: {
              patterns: {
                patternFourthBar: { clap: '----x---' },
                patternEndOfSegment: { clap: '-x-x-x-x' },
              },
            },
          },
          mutes: { Pad: { from: 0, to: 1 } as never },
          signalProcessors: {
            Drums: {
              type: 'lowPassFilter1000SweepUp',
              lowPassFilter: [
                { pointIn32ndNotes: 0, value: 1000 },
                { pointIn32ndNotes: 32, value: 30000 },
              ],
            } as never,
          },
          transitions: { Riser: { at: 0 } as never },
        },
      },
      instrumentDefinitions: [],
      aiArtifacts: [],
      generator: {
        name: 'orchestrate',
        version: '0.1.0',
        seed: 'demo-1',
        params: { genre: 'brightPop', key: 'C', bpm: 120 },
      },
    } as never,
  };
}
