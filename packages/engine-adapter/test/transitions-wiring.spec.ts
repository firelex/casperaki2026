// docs/54p hardening — pin the end-to-end `toEngineFixture` behaviour
// around fills pass-through + TransitionSample lowering. The unit-level
// behaviour of resolveTransitionRow / computeTransitionTiming /
// buildTransitionAssets lives in transitions.spec.ts; this file pins
// the integration: brain → adapter → emitted envelope + inst files.

import { describe, expect, it } from 'vitest';

import type { Song } from '@casperaki/song-schema';

import { loadValidatedCatalog } from '@casperaki/arrangement';

import { toEngineFixture } from '../src/index.js';

const PARAMS = Object.freeze({
  genre: 'brightPop',
  key: 'C',
  bpm: 120,
  seed: 'brightPop-vertical-slice',
});
const HASH = 'cafef00d'.repeat(8);

// Four-bar segment template. Just enough chords to keep the engine
// envelope's structure schema happy.
const FOUR_BAR_CHORDS: string[][] = [
  ['C', 'C', 'C', 'C'],
  ['Dm', 'Dm', 'Dm', 'Dm'],
  ['A#9', 'A#9', 'A#9', 'A#9'],
  ['C', 'C', 'C', 'C'],
];

// Drum-active bar (kick + snare). Mirrors makeBrainSong() in
// to-engine-fixture.spec.ts so the engine treats Drums as active for
// the segment — which is what enables the fills.Drums lowering path.
const DRUM_BAR = {
  notes: {
    '0.0': [{ type: 'note', note: 36, duration: 0.25 }],
    '1.0': [{ type: 'note', note: 38, duration: 0.25 }],
    '2.0': [{ type: 'note', note: 36, duration: 0.25 }],
    '3.0': [{ type: 'note', note: 38, duration: 0.25 }],
  },
};

function makeSongWithFills(): Song {
  return {
    schemaVersion: '1.0.0',
    key: 'C', bpm: 120, genre: 'brightPop',
    songStructure: [
      { name: 'chorus1', bars: FOUR_BAR_CHORDS.map((chords) => ({ chords })) },
    ],
    arrangement: {
      chorus1: {
        instruments: { Drums: true },
        overrides: { Drums: { bars: [DRUM_BAR] } },
        fills: {
          Drums: {
            reset: false,
            patterns: {
              patternEndOfSegment: {
                clap: '00000000 00000000 00000000 x0x0x0x0',
              },
            },
          },
        },
        mutes: {},
        signalProcessors: {},
        transitions: {},
      },
    },
    instrumentDefinitions: [],
    aiArtifacts: [],
  } as unknown as Song;
}

function makeSongWithRepeatedTransitionTag(): Song {
  // Same `fxTonalReverse` tag emitted on TWO segments. The pre-54p / pre-
  // unique-naming adapter would have produced two insts with the same
  // `name` field, triggering the engine routing collision documented in
  // docs/54p §"Engine routing collision".
  return {
    schemaVersion: '1.0.0',
    key: 'C', bpm: 120, genre: 'brightPop',
    songStructure: [
      { name: 'intro',  bars: FOUR_BAR_CHORDS.map((chords) => ({ chords })) },
      { name: 'verse1', bars: FOUR_BAR_CHORDS.map((chords) => ({ chords })) },
    ],
    arrangement: {
      intro: {
        instruments: { Drums: true },
        overrides: { Drums: { bars: [DRUM_BAR] } },
        fills: {}, mutes: {}, signalProcessors: {},
        transitions: {
          fxTonalReverse: { type: 'fxTonalReverse', placement: 'endOfSegment' },
        },
      },
      verse1: {
        instruments: { Drums: true },
        overrides: { Drums: { bars: [DRUM_BAR] } },
        fills: {}, mutes: {}, signalProcessors: {},
        transitions: {
          fxTonalReverse: { type: 'fxTonalReverse', placement: 'endOfSegment' },
          cymbalsCrashHit: { type: 'cymbalsCrashHit', placement: 'beginningOfSegment' },
        },
      },
    },
    instrumentDefinitions: [],
    aiArtifacts: [],
  } as unknown as Song;
}

interface EmittedEnvelope {
  arrangement: Record<string, {
    instruments: Record<string, boolean>;
    fills: Record<string, unknown>;
    transitions: Record<string, unknown>;
  }>;
}
interface EmittedInst {
  filename: string;
  json: {
    id: number;
    name: string;
    type: string;
    lowLevelType?: string;
    details?: { duration?: number; climax?: number; bpm?: number };
  };
}

describe('toEngineFixture — fills pass-through (docs/54o + 54p hardening)', () => {
  it('passes the brain `fills.Drums` block through verbatim', () => {
    const fixture = toEngineFixture(makeSongWithFills(), {
      brainHash: HASH,
      generatorParams: PARAMS,
    });
    const env = fixture.songJson as EmittedEnvelope;
    const fills = env.arrangement.chorus1.fills as Record<string, unknown>;
    expect(Object.keys(fills)).toEqual(['Drums']);
    const drums = fills.Drums as {
      reset: boolean;
      patterns: { patternEndOfSegment: { clap: string } };
    };
    expect(drums.reset).toBe(false);
    expect(drums.patterns.patternEndOfSegment.clap).toBe(
      '00000000 00000000 00000000 x0x0x0x0',
    );
  });

  it('emits empty `fills: {}` when brain has no fills', () => {
    // Use the existing one-segment Drums-only template (no fills set).
    const song = makeSongWithFills();
    (song.arrangement as Record<string, { fills: Record<string, unknown> }>).chorus1.fills = {};
    const fixture = toEngineFixture(song, { brainHash: HASH, generatorParams: PARAMS });
    const env = fixture.songJson as EmittedEnvelope;
    expect(env.arrangement.chorus1.fills).toEqual({});
  });
});

describe('toEngineFixture — transitions wiring (docs/54p)', () => {
  const catalog = loadValidatedCatalog();
  const probe = (entry: { id: string }) => {
    // Deterministic per-row "duration". Real ffprobe values vary; for tests
    // we just need a positive number so the resolver doesn't drop.
    return 2.5;
  };

  it('emits NO transition inst-N.json when transitionCatalog is omitted', () => {
    const fixture = toEngineFixture(makeSongWithRepeatedTransitionTag(), {
      brainHash: HASH, generatorParams: PARAMS,
      // intentionally NOT passing transitionCatalog
    });
    const transitionInsts = (fixture.instruments as EmittedInst[])
      .filter((i) => i.json.type === 'transitionSample');
    expect(transitionInsts).toEqual([]);
    const env = fixture.songJson as EmittedEnvelope;
    expect(env.arrangement.intro.transitions).toEqual({});
    expect(env.arrangement.verse1.transitions).toEqual({});
  });

  it('emits NO transition inst-N.json when getTransitionSampleDurationSeconds is omitted', () => {
    const fixture = toEngineFixture(makeSongWithRepeatedTransitionTag(), {
      brainHash: HASH, generatorParams: PARAMS,
      transitionCatalog: catalog,
      // intentionally NOT passing getTransitionSampleDurationSeconds
    });
    const transitionInsts = (fixture.instruments as EmittedInst[])
      .filter((i) => i.json.type === 'transitionSample');
    expect(transitionInsts).toEqual([]);
  });

  it('emits a transition diagnostic with action="dropped" when probe is missing', () => {
    const fixture = toEngineFixture(makeSongWithRepeatedTransitionTag(), {
      brainHash: HASH, generatorParams: PARAMS,
      transitionCatalog: catalog,
    });
    const drop = fixture.diagnostics.find(
      (d) => d.path === 'arrangement.transitions' && d.action === 'dropped'
    );
    expect(drop).toBeDefined();
    expect(drop!.message).toMatch(/3 transition tag\(s\)/);
    expect(drop!.message).toMatch(/getTransitionSampleDurationSeconds/);
  });

  it('emits unique inst names for the same tag across multiple segments', () => {
    const fixture = toEngineFixture(makeSongWithRepeatedTransitionTag(), {
      brainHash: HASH, generatorParams: PARAMS,
      transitionCatalog: catalog,
      getTransitionSampleDurationSeconds: probe,
    });
    const transitionInsts = (fixture.instruments as EmittedInst[])
      .filter((i) => i.json.type === 'transitionSample');
    expect(transitionInsts.length).toBe(3);
    // Three distinct names: one per (tag, segment) pair.
    const names = transitionInsts.map((i) => i.json.name).sort();
    expect(names).toEqual([
      'cymbalsCrashHit__verse1',
      'fxTonalReverse__intro',
      'fxTonalReverse__verse1',
    ]);
    // Three distinct playsample ids.
    const ids = new Set(transitionInsts.map((i) => i.json.id));
    expect(ids.size).toBe(3);
  });

  it('arrangement.<seg>.transitions key matches inst.json.name for every emitted inst (engine routing contract)', () => {
    const fixture = toEngineFixture(makeSongWithRepeatedTransitionTag(), {
      brainHash: HASH, generatorParams: PARAMS,
      transitionCatalog: catalog,
      getTransitionSampleDurationSeconds: probe,
    });
    const env = fixture.songJson as EmittedEnvelope;
    const transitionInsts = (fixture.instruments as EmittedInst[])
      .filter((i) => i.json.type === 'transitionSample');
    // Recover (segment, name) by walking arrangement.transitions for each seg.
    const arrangementPairs: Array<{ seg: string; name: string }> = [];
    for (const [seg, arrAny] of Object.entries(env.arrangement)) {
      for (const name of Object.keys(arrAny.transitions)) {
        arrangementPairs.push({ seg, name });
      }
    }
    expect(arrangementPairs.length).toBe(transitionInsts.length);
    for (const inst of transitionInsts) {
      const expectedSeg = inst.json.name.split('__')[1];
      const pair = arrangementPairs.find((p) => p.name === inst.json.name);
      expect(pair, `inst.name ${inst.json.name} should appear in arrangement`).toBeDefined();
      expect(pair!.seg).toBe(expectedSeg);
    }
  });

  it('flags the activated transition in the per-segment instruments map (engine isInstrumentInSegment requires this)', () => {
    const fixture = toEngineFixture(makeSongWithRepeatedTransitionTag(), {
      brainHash: HASH, generatorParams: PARAMS,
      transitionCatalog: catalog,
      getTransitionSampleDurationSeconds: probe,
    });
    const env = fixture.songJson as EmittedEnvelope;
    expect(env.arrangement.intro.instruments['fxTonalReverse__intro']).toBe(true);
    expect(env.arrangement.verse1.instruments['fxTonalReverse__verse1']).toBe(true);
    expect(env.arrangement.verse1.instruments['cymbalsCrashHit__verse1']).toBe(true);
    // Cross-segment flags should NOT be set (this is the routing-collision
    // contract — the engine's dispatch would otherwise try to fire the
    // intro inst on verse1).
    expect(env.arrangement.verse1.instruments['fxTonalReverse__intro']).toBeUndefined();
    expect(env.arrangement.intro.instruments['fxTonalReverse__verse1']).toBeUndefined();
  });

  it('emits the lowered-transitions diagnostic with by-tag + by-source counts', () => {
    const fixture = toEngineFixture(makeSongWithRepeatedTransitionTag(), {
      brainHash: HASH, generatorParams: PARAMS,
      transitionCatalog: catalog,
      getTransitionSampleDurationSeconds: probe,
    });
    const ok = fixture.diagnostics.find(
      (d) => d.path === 'arrangement.transitions' && d.action === 'normalized'
    );
    expect(ok).toBeDefined();
    expect(ok!.message).toMatch(/Lowered 3 transitionSample inst\(s\) across 2 segment\(s\)/);
    expect(ok!.message).toMatch(/fxTonalReverse=2/);
    expect(ok!.message).toMatch(/cymbalsCrashHit=1/);
    expect(ok!.message).toMatch(/Catalog source:/);
  });

  it('transition playsample ids start at the documented base (40000) and increment per inst', () => {
    const fixture = toEngineFixture(makeSongWithRepeatedTransitionTag(), {
      brainHash: HASH, generatorParams: PARAMS,
      transitionCatalog: catalog,
      getTransitionSampleDurationSeconds: probe,
    });
    const transitionInsts = (fixture.instruments as EmittedInst[])
      .filter((i) => i.json.type === 'transitionSample')
      .sort((a, b) => a.json.id - b.json.id);
    expect(transitionInsts[0]!.json.id).toBe(40000);
    expect(transitionInsts[1]!.json.id).toBe(40001);
    expect(transitionInsts[2]!.json.id).toBe(40002);
  });

  it('respects a custom transitionPlaysampleIdBase', () => {
    const fixture = toEngineFixture(makeSongWithRepeatedTransitionTag(), {
      brainHash: HASH, generatorParams: PARAMS,
      transitionCatalog: catalog,
      getTransitionSampleDurationSeconds: probe,
      transitionPlaysampleIdBase: 99000,
    });
    const transitionInsts = (fixture.instruments as EmittedInst[])
      .filter((i) => i.json.type === 'transitionSample')
      .sort((a, b) => a.json.id - b.json.id);
    expect(transitionInsts.map((i) => i.json.id)).toEqual([99000, 99001, 99002]);
  });
});

describe('toEngineFixture — edmSnareDrumRoll TransitionPattern wiring (docs/54n)', () => {
  const catalog = loadValidatedCatalog();
  const probe = () => 2.5;

  // Brain output: a bridge segment whose edmSnareDrumRoll entry carries the
  // generated grid + lengthInBars (see arrangement-polish/edm-snare-roll.ts).
  function makeSongWithSnareRoll(): Song {
    return {
      schemaVersion: '1.0.0',
      key: 'C', bpm: 128, genre: 'edm',
      songStructure: [
        { name: 'bridge1', bars: FOUR_BAR_CHORDS.map((chords) => ({ chords })) },
      ],
      arrangement: {
        bridge1: {
          instruments: { Drums: true },
          overrides: { Drums: { bars: [DRUM_BAR] } },
          fills: {}, mutes: {}, signalProcessors: {},
          transitions: {
            edmSnareDrumRoll: {
              type: 'edmSnareDrumRoll',
              placement: 'endOfSegment',
              pattern: {
                snareDrum1: 'x0x0x0x0 x0x0x0x0 xxxxxxxx xxxxxxxx',
                snareDrum2: 'x00x00x0 x00x00x0 x00x00x0 x00x00x0',
              },
              lengthInBars: 1,
            },
          },
        },
      },
      instrumentDefinitions: [],
      aiArtifacts: [],
    } as unknown as Song;
  }

  it('emits a transitionPattern inst with two snare samples', () => {
    const fixture = toEngineFixture(makeSongWithSnareRoll(), {
      brainHash: HASH, generatorParams: { ...PARAMS, genre: 'edm', bpm: 128 },
      transitionCatalog: catalog, getTransitionSampleDurationSeconds: probe,
    });
    const patternInsts = (fixture.instruments as EmittedInst[])
      .filter((i) => i.json.type === 'transitionPattern');
    expect(patternInsts.length).toBe(1);
    const inst = patternInsts[0]!.json as unknown as {
      name: string; lowLevelType: string; sampleOrVst: string;
      samples: Array<{ note: string; id: number }>;
    };
    expect(inst.name).toBe('edmSnareDrumRoll__bridge1');
    expect(inst.lowLevelType).toBe('snareDrumsElectronic');
    expect(inst.sampleOrVst).toBe('twoSamples');
    expect(inst.samples).toHaveLength(2);
    expect(inst.samples.map((s) => s.note)).toEqual(['C1', 'G1']);
  });

  it('routes the pattern block by id (block.id === inst.id) and carries the grid', () => {
    const fixture = toEngineFixture(makeSongWithSnareRoll(), {
      brainHash: HASH, generatorParams: { ...PARAMS, genre: 'edm', bpm: 128 },
      transitionCatalog: catalog, getTransitionSampleDurationSeconds: probe,
    });
    const inst = (fixture.instruments as EmittedInst[])
      .find((i) => i.json.type === 'transitionPattern')!.json;
    const env = fixture.songJson as EmittedEnvelope;
    const block = env.arrangement.bridge1!.transitions['edmSnareDrumRoll__bridge1'] as {
      id: number; sequenceStartPosition: number;
      config: { details: { pattern: Record<string, string>; lengthInBars: number } };
    };
    expect(block).toBeDefined();
    expect(block.id).toBe(inst.id);
    expect(block.config.details.lengthInBars).toBe(1);
    expect(block.config.details.pattern.snareDrum1).toBeDefined();
    // 1-bar roll @128bpm on a 4-bar segment: segDur=7.5s, segEnd_32=128,
    // start = 128 - 1*32 = 96.
    expect(block.sequenceStartPosition).toBe(96);
    // Engine isInstrumentInSegment requires the activation flag.
    expect(env.arrangement.bridge1!.instruments['edmSnareDrumRoll__bridge1']).toBe(true);
  });
});
