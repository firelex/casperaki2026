// @casperaki/engine-adapter — toEngineFixture() unit tests.
//
// These tests pin the multi-segment Drums+Bass+Keys+Pad lowering. The
// adapter walks the brain's full songStructure (step 15 / docs/53z),
// replacing the prior single-engine-segment proof graft (step 9 / 53t).
//
// Each describe() block builds the smallest plausible canonical Song
// stand-in that exercises the slice of the adapter under test, without
// pulling in the @casperaki/arrangement orchestrator. The first block
// pins the per-family Drums-only / Bass-only / Keys+Pad lowering shape
// using a one-segment songStructure (chorus1 only); the multi-segment
// block exercises the songStructure walk explicitly.

import { describe, expect, it } from 'vitest';

import type { Song } from '@casperaki/song-schema';

import { midiToEngineNoteName, toEngineFixture } from '../src/index.js';

const PARAMS = Object.freeze({
  genre: 'brightPop',
  key: 'C',
  bpm: 120,
  seed: 'brightPop-vertical-slice',
});

const HASH = 'deadbeef'.repeat(8);

const FOUR_BAR_CHORDS = [
  ['C', 'C', 'C', 'C'],
  ['Dm', 'Dm', 'Dm', 'Dm'],
  ['A#9', 'A#9', 'A#9', 'A#9'],
  ['C', 'C', 'C', 'C'],
];

/**
 * One-segment Drums-only Song stand-in. Keeps the brain songStructure to
 * just `chorus1` so the single-segment fallback path stays exercised and
 * older Drums/Bass/Keys/Pad invariants can be asserted on a stable
 * envelope.arrangement.chorus1.* key.
 */
function makeBrainSong(): Song {
  const chorusDrumBar = {
    notes: {
      '0.0': [
        { type: 'note', note: 36, duration: 0.25 },
        { type: 'note', note: 42, duration: 0.25 },
      ],
      '0.5': [{ type: 'note', note: 42, duration: 0.25 }],
      '1.0': [
        { type: 'note', note: 38, duration: 0.25 },
        { type: 'note', note: 42, duration: 0.25 },
      ],
      '1.5': [{ type: 'note', note: 42, duration: 0.25 }],
      '2.0': [
        { type: 'note', note: 36, duration: 0.25 },
        { type: 'note', note: 42, duration: 0.25 },
      ],
      '2.5': [{ type: 'note', note: 42, duration: 0.25 }],
      '3.0': [
        { type: 'note', note: 38, duration: 0.25 },
        { type: 'note', note: 42, duration: 0.25 },
      ],
      '3.5': [{ type: 'note', note: 42, duration: 0.25 }],
    },
  };
  return {
    schemaVersion: '1.0.0',
    key: 'C',
    bpm: 120,
    genre: 'brightPop',
    songStructure: [
      { name: 'chorus1', bars: FOUR_BAR_CHORDS.map((chords) => ({ chords })) },
    ],
    arrangement: {
      chorus1: {
        instruments: { Drums: true },
        overrides: {
          Drums: { bars: [chorusDrumBar] },
        },
        fills: {},
        mutes: {},
        signalProcessors: {},
        transitions: {},
      },
    },
    instrumentDefinitions: [],
    aiArtifacts: [],
  } as unknown as Song;
}

interface EmittedSegmentArrangement {
  instruments: Record<string, boolean>;
  overrides: Record<string, EmittedAnyOverride>;
  fills: Record<string, unknown>;
  mutes: Record<string, unknown>;
  signalProcessors: Record<string, unknown>;
  transitions: Record<string, unknown>;
}
interface EmittedAnyOverride {
  type?: string;
  pattern?: Record<string, string>;
  bars?: Array<{
    notes: Record<
      string,
      Array<
        | { type: 'noteAbsolute'; note: string; duration: number }
        | { type: 'chord'; chord: string; chordType: string; duration: number }
      >
    >;
  }>;
}
interface EmittedEnvelope {
  key: string;
  tempo: number;
  genre?: string;
  brainProvenance: { generator: string; hash: string; params: typeof PARAMS };
  structure: Array<{ segment: string; bars: Array<{ chords: string[] }> }>;
  arrangement: Record<string, EmittedSegmentArrangement>;
}

interface EmittedDrumsInst {
  name: string;
  ids: Record<string, number>;
  subInstruments: Record<string, unknown>;
}

describe('toEngineFixture (single-segment Drums-only)', () => {
  it('emits the songJson + a single inst-1.json instrument file', () => {
    const fixture = toEngineFixture(makeBrainSong(), {
      brainHash: HASH,
      generatorParams: PARAMS,
    });
    expect(fixture.songJson).toBeTruthy();
    expect(fixture.instruments).toHaveLength(1);
    expect(fixture.instruments[0]!.filename).toBe('inst-1.json');
  });

  it('carries brain bpm/key/genre and provenance into the engine envelope', () => {
    const fixture = toEngineFixture(makeBrainSong(), {
      brainHash: HASH,
      generatorParams: PARAMS,
    });
    const envelope = fixture.songJson as EmittedEnvelope;
    expect(envelope.tempo).toBe(PARAMS.bpm);
    expect(envelope.key).toBe(PARAMS.key);
    expect(envelope.genre).toBe(PARAMS.genre);
    expect(envelope.brainProvenance.hash).toBe(HASH);
    expect(envelope.brainProvenance.params).toEqual(PARAMS);
    expect(envelope.brainProvenance.generator).toBe('@casperaki/arrangement.orchestrate');
  });

  it('lets the caller override the generator name on the provenance block', () => {
    const fixture = toEngineFixture(makeBrainSong(), {
      brainHash: HASH,
      generatorParams: PARAMS,
      generatorName: 'custom-driver',
    });
    expect((fixture.songJson as EmittedEnvelope).brainProvenance.generator).toBe(
      'custom-driver',
    );
  });

  it('emits a single engine chorus1 segment carrying brain chord roots', () => {
    const fixture = toEngineFixture(makeBrainSong(), {
      brainHash: HASH,
      generatorParams: PARAMS,
    });
    const envelope = fixture.songJson as EmittedEnvelope;
    expect(envelope.structure).toHaveLength(1);
    const seg = envelope.structure[0]!;
    expect(seg.segment).toBe('chorus1');
    expect(seg.bars).toHaveLength(4);
    expect(seg.bars.map((b) => b.chords[0])).toEqual(['C', 'Dm', 'A#9', 'C']);
    for (const bar of seg.bars) expect(bar.chords).toHaveLength(4);
  });

  it('lowers brain drum MIDI events into the engine 32nd-note ASCII grid', () => {
    const fixture = toEngineFixture(makeBrainSong(), {
      brainHash: HASH,
      generatorParams: PARAMS,
    });
    const envelope = fixture.songJson as EmittedEnvelope;
    const pattern = envelope.arrangement.chorus1!.overrides.Drums!.pattern!;
    expect(pattern.bassDrum1).toBe('x000000000000000x000000000000000');
    expect(pattern.snareDrum1).toBe('00000000x000000000000000x0000000');
    expect(pattern.hiHatClosed1).toBe('x000x000x000x000x000x000x000x000');
    expect(envelope.arrangement.chorus1!.overrides.Drums!.type).toBe('brainRoundtrip');
    // The segment's pattern must replace the kit's base pattern, or the engine plays the base.
    expect((envelope.arrangement.chorus1!.overrides.Drums as { reset?: boolean }).reset).toBe(true);
  });

  it('emits the full 17-id Drums kit as inst-1.json (engine constructor requirement)', () => {
    const fixture = toEngineFixture(makeBrainSong(), {
      brainHash: HASH,
      generatorParams: PARAMS,
    });
    const inst = fixture.instruments[0]!.json as EmittedDrumsInst;
    expect(inst.name).toBe('Drums');
    expect(Object.keys(inst.ids).sort()).toEqual([
      'bassDrum1', 'bassDrum2', 'clap', 'crash1', 'crash2',
      'hiHatClosed1', 'hiHatClosed2', 'hiHatOpen', 'hiHatPedal',
      'ride', 'shaker', 'snap', 'snareDrum1', 'snareDrum2',
      'tom1', 'tom2', 'tom3',
    ]);
    expect(Object.keys(inst.subInstruments).length).toBe(17);
  });

  it('flags multi-segment + per-family diagnostics; skipped Bass/Keys/Pad are dropped', () => {
    const fixture = toEngineFixture(makeBrainSong(), {
      brainHash: HASH,
      generatorParams: PARAMS,
    });
    const paths = fixture.diagnostics.map((d) => d.path);
    expect(paths).toContain('structure');
    expect(paths).toContain('arrangement');
    expect(paths).toContain('overrides.Drums');
    expect(paths).toContain('instrumentDefinitions.Drums');
    // The Drums-only Song fixture has no Bass/Keys/Pad overrides — the
    // adapter emits a single "skipped" diagnostic per inactive family.
    expect(paths).toContain('overrides.Bass');
    expect(paths).toContain('overrides.Keys');
    expect(paths).toContain('overrides.Pad');
    const joined = fixture.diagnostics.map((d) => d.message).join('\n');
    expect(joined).toMatch(/Drums lowering/);
    expect(joined).toMatch(/Multi-segment lowering/);
    expect(joined).toMatch(/Drum kit lowering deferred/);
    expect(joined).toMatch(/Bass lowering skipped/);
    expect(joined).toMatch(/Keys lowering skipped/);
    expect(joined).toMatch(/Pad lowering skipped/);
    for (const d of fixture.diagnostics) {
      // No unresolved-resolver warnings in this fixture.
      expect(d.severity).toBe('info');
    }
  });

  it('throws if the brain Song has no songStructure entries', () => {
    const song = makeBrainSong();
    song.songStructure = [];
    expect(() =>
      toEngineFixture(song, { brainHash: HASH, generatorParams: PARAMS }),
    ).toThrow(/songStructure/);
  });

  it('is deterministic — same input produces byte-identical output', () => {
    const a = toEngineFixture(makeBrainSong(), { brainHash: HASH, generatorParams: PARAMS });
    const b = toEngineFixture(makeBrainSong(), { brainHash: HASH, generatorParams: PARAMS });
    expect(JSON.stringify(a.songJson)).toBe(JSON.stringify(b.songJson));
    expect(JSON.stringify(a.instruments)).toBe(JSON.stringify(b.instruments));
  });
});

// ---- Bass lowering -----------------------------------------------------

interface EmittedBassInst {
  id: number;
  name: string;
  type: string;
  lowLevelType: string;
  samples: Array<{
    id: number;
    note: string;
    type: 'longNote' | 'shortNote';
    vst: number;
  }>;
}

function makeBrainSongWithBass(): Song {
  // bar0 root C → MIDI 36; bar1 root D → MIDI 38; bar2 root A# → MIDI 46;
  // bar3 root C → MIDI 36. Matches the brain's chord-aware bass output.
  const bassBars = [36, 38, 46, 36].map((midi) => ({
    notes: {
      '0.0': [{ type: 'note', note: midi, duration: 0.5 }],
      '0.5': [{ type: 'note', note: midi, duration: 0.75 }],
      '1.5': [{ type: 'note', note: midi, duration: 1 }],
    },
  }));
  return {
    schemaVersion: '1.0.0',
    key: 'C',
    bpm: 120,
    genre: 'brightPop',
    songStructure: [
      { name: 'chorus1', bars: FOUR_BAR_CHORDS.map((chords) => ({ chords })) },
    ],
    arrangement: {
      chorus1: {
        instruments: { Drums: true, Bass: true },
        overrides: {
          Drums: {
            bars: [
              {
                notes: {
                  '0.0': [{ type: 'note', note: 36, duration: 0.25 }],
                  '2.0': [{ type: 'note', note: 38, duration: 0.25 }],
                },
              },
            ],
          },
          Bass: { bars: bassBars },
        },
        fills: {},
        mutes: {},
        signalProcessors: {},
        transitions: {},
      },
    },
    instrumentDefinitions: [
      {
        id: 'b1a76948693cbc65',
        name: 'Bass',
        shortName: 'serum - BA Trancy Bass',
        type: 'bassesSynthDistorted',
        lowLevelType: 'bassesSynthDistorted',
        instrumentGroup: 'basses',
      },
    ],
    aiArtifacts: [],
  } as unknown as Song;
}

describe('midiToEngineNoteName', () => {
  it('maps MIDI 36 → c2 (octave 0 starts at MIDI 12)', () => {
    expect(midiToEngineNoteName(36)).toBe('c2');
  });
  it('uses sharp accidentals and lowercase letters', () => {
    expect(midiToEngineNoteName(46)).toBe('a#2');
    expect(midiToEngineNoteName(49)).toBe('c#3');
    expect(midiToEngineNoteName(38)).toBe('d2');
  });
  it('round-trips the legacy Bass VST sample notes', () => {
    expect(midiToEngineNoteName(36)).toBe('c2');
    expect(midiToEngineNoteName(39)).toBe('d#2');
    expect(midiToEngineNoteName(42)).toBe('f#2');
    expect(midiToEngineNoteName(45)).toBe('a2');
    expect(midiToEngineNoteName(48)).toBe('c3');
    expect(midiToEngineNoteName(51)).toBe('d#3');
  });
  it('throws on out-of-range MIDI values', () => {
    expect(() => midiToEngineNoteName(-1)).toThrow(/out-of-range/);
    expect(() => midiToEngineNoteName(128)).toThrow(/out-of-range/);
  });
});

describe('toEngineFixture (Bass)', () => {
  it('emits inst-2.json carrying the legacy 16-sample bassesSynthSoft VST kit', () => {
    const fixture = toEngineFixture(makeBrainSongWithBass(), {
      brainHash: HASH,
      generatorParams: PARAMS,
    });
    expect(fixture.instruments.length).toBe(2);
    expect(fixture.instruments[0]!.filename).toBe('inst-1.json');
    expect(fixture.instruments[1]!.filename).toBe('inst-2.json');
    const bass = fixture.instruments[1]!.json as EmittedBassInst;
    expect(bass.id).toBe(38842);
    expect(bass.name).toBe('Bass');
    expect(bass.type).toBe('basses');
    expect(bass.lowLevelType).toBe('bassesSynthSoft');
    expect(bass.samples).toHaveLength(16);
    const ids = bass.samples.map((s) => s.id).sort((a, b) => a - b);
    expect(ids[0]).toBe(945);
    expect(ids[ids.length - 1]).toBe(960);
  });

  it('lowers brain MIDI bass events into engine noteAbsolute strings, preserving BarBeat keys', () => {
    const fixture = toEngineFixture(makeBrainSongWithBass(), {
      brainHash: HASH,
      generatorParams: PARAMS,
    });
    const envelope = fixture.songJson as EmittedEnvelope;
    const bassOverride = envelope.arrangement.chorus1!.overrides.Bass!;
    expect(bassOverride.type).toBe('brainRoundtrip');
    expect(bassOverride.bars).toHaveLength(4);

    const bar0 = bassOverride.bars![0]!;
    expect(Object.keys(bar0.notes).sort()).toEqual(['0.0', '0.5', '1.5']);
    const ev = bar0.notes['0.0']![0]! as { type: string; note: string; duration: number };
    expect(ev.type).toBe('noteAbsolute');
    expect(ev.note).toBe('c2');
    expect(ev.duration).toBe(0.5);

    // Chord-aware brain bass: bar1 (Dm) → d2; bar2 (A#9) → a#2; bar3 (C) → c2.
    expect((bassOverride.bars![1]!.notes['0.0']![0]! as { note: string }).note).toBe('d2');
    expect((bassOverride.bars![2]!.notes['0.0']![0]! as { note: string }).note).toBe('a#2');
    expect((bassOverride.bars![3]!.notes['0.0']![0]! as { note: string }).note).toBe('c2');

    expect(envelope.arrangement.chorus1!.instruments.Bass).toBe(true);
    expect(envelope.arrangement.chorus1!.instruments.Drums).toBe(true);
  });

  it('emits adapter diagnostics describing Bass lowering scope', () => {
    const fixture = toEngineFixture(makeBrainSongWithBass(), {
      brainHash: HASH,
      generatorParams: PARAMS,
    });
    const paths = fixture.diagnostics.map((d) => d.path);
    expect(paths).toContain('overrides.Bass');
    expect(paths).toContain('instrumentDefinitions.Bass');
    expect(paths).toContain('assetResolver.Bass');
    expect(paths).toContain('overrides.Drums');
    expect(paths).toContain('instrumentDefinitions.Drums');

    const bassResolverDiag = fixture.diagnostics.find(
      (d) => d.path === 'assetResolver.Bass',
    )!;
    expect(bassResolverDiag.message).toMatch(/not supplied/);
  });

  it('records a wired resolver verdict in diagnostics (resolved case)', () => {
    const fixture = toEngineFixture(makeBrainSongWithBass(), {
      brainHash: HASH,
      generatorParams: PARAMS,
      bassAssetResolution: {
        status: 'resolved',
        relativePath: 'bass/serum/BA Trancy Bass - C 120bpm.ogg',
        matchKind: 'canonical',
        entryId: 'b1a76948693cbc65',
      },
    });
    const d = fixture.diagnostics.find((x) => x.path === 'assetResolver.Bass')!;
    expect(d.severity).toBe('info');
    expect(d.message).toMatch(/resolved \(canonical\)/);
    expect(d.message).toContain('bass/serum/BA Trancy Bass - C 120bpm.ogg');
    expect(d.message).toContain('b1a76948693cbc65');
  });

  it('overrides the fixture lowLevelType with the resolved catalog row lowLevel', () => {
    const fixture = toEngineFixture(makeBrainSongWithBass(), {
      brainHash: HASH,
      generatorParams: PARAMS,
      bassAssetResolution: {
        status: 'resolved',
        relativePath: 'basses/bassesElectric/foo.mp3',
        matchKind: 'canonical',
        entryId: 'b1a76948693cbc65',
        family: 'basses',
        lowLevel: 'bassesElectric',
      },
    });
    const bass = fixture.instruments[1]!.json as EmittedBassInst;
    // lowLevelType tracks the selection (drives volume + FX routing)...
    expect(bass.lowLevelType).toBe('bassesElectric');
    // ...while `type` stays the fixture's engine-dispatch value.
    expect(bass.type).toBe('basses');
  });

  it('keeps the fixture lowLevelType when the resolver did not resolve', () => {
    const fixture = toEngineFixture(makeBrainSongWithBass(), {
      brainHash: HASH,
      generatorParams: PARAMS,
      bassAssetResolution: {
        status: 'unresolved',
        reason: 'no pool match',
        entryId: 'b1a76948693cbc65',
        family: 'basses',
        lowLevel: 'bassesElectric',
      },
    });
    const bass = fixture.instruments[1]!.json as EmittedBassInst;
    expect(bass.lowLevelType).toBe('bassesSynthSoft');
  });

  it('records an unresolved verdict as a warning diagnostic', () => {
    const fixture = toEngineFixture(makeBrainSongWithBass(), {
      brainHash: HASH,
      generatorParams: PARAMS,
      bassAssetResolution: {
        status: 'unresolved',
        reason: "target (key=C, bpm=120) not present in this entry's pool",
        entryId: 'b1a76948693cbc65',
      },
    });
    const d = fixture.diagnostics.find((x) => x.path === 'assetResolver.Bass')!;
    expect(d.severity).toBe('warning');
    expect(d.message).toMatch(/unresolved/);
    expect(d.message).toContain('not present');
  });

  it('is deterministic for the Bass-active input', () => {
    const a = toEngineFixture(makeBrainSongWithBass(), {
      brainHash: HASH,
      generatorParams: PARAMS,
    });
    const b = toEngineFixture(makeBrainSongWithBass(), {
      brainHash: HASH,
      generatorParams: PARAMS,
    });
    expect(JSON.stringify(a.songJson)).toBe(JSON.stringify(b.songJson));
    expect(JSON.stringify(a.instruments)).toBe(JSON.stringify(b.instruments));
    expect(JSON.stringify(a.diagnostics)).toBe(JSON.stringify(b.diagnostics));
  });

  it('Drums-only path is byte-stable: turning on Bass does NOT change Drums kit bytes', () => {
    const drumsOnly = toEngineFixture(makeBrainSong(), {
      brainHash: HASH,
      generatorParams: PARAMS,
    });
    const withBass = toEngineFixture(makeBrainSongWithBass(), {
      brainHash: HASH,
      generatorParams: PARAMS,
    });
    expect(JSON.stringify(drumsOnly.instruments[0]!.json)).toBe(
      JSON.stringify(withBass.instruments[0]!.json),
    );
  });
});

// ---- Keys + Pad lowering ----------------------------------------------

interface EmittedTonalInst {
  id: number;
  name: string;
  type: string;
  lowLevelType: string;
  instrumentGroup: string;
  samples: Array<{ id: number; note: string; type: 'longNote' | 'shortNote'; vst: number }>;
}

function makeChordOverrideBars(
  chordsPerBar: ReadonlyArray<string>,
  duration: number,
): Array<{ notes: Record<string, Array<{ type: string; chord: string; duration: number }>> }> {
  return chordsPerBar.map((chord) => ({
    notes: {
      '0.0': [{ type: 'chord', chord, duration }],
    },
  }));
}

function makeBrainSongWithKeysAndPad(): Song {
  return {
    schemaVersion: '1.0.0',
    key: 'C',
    bpm: 120,
    genre: 'brightPop',
    songStructure: [
      { name: 'chorus1', bars: FOUR_BAR_CHORDS.map((chords) => ({ chords })) },
    ],
    arrangement: {
      chorus1: {
        instruments: { Drums: true, Keys: true, Pad: true },
        overrides: {
          Drums: {
            bars: [
              {
                notes: {
                  '0.0': [{ type: 'note', note: 36, duration: 0.25 }],
                  '2.0': [{ type: 'note', note: 38, duration: 0.25 }],
                },
              },
            ],
          },
          Keys: { bars: makeChordOverrideBars(['C', 'Dm', 'A#9', 'C'], 2) },
          Pad: { bars: makeChordOverrideBars(['C', 'Dm', 'A#9', 'C'], 4) },
        },
        fills: {},
        mutes: {},
        signalProcessors: {},
        transitions: {},
      },
    },
    instrumentDefinitions: [
      {
        id: '7f7952be598f9294',
        name: 'Keys',
        shortName: 'piano',
        type: 'keysAcousticPiano',
        lowLevelType: 'keysAcousticPiano',
        instrumentGroup: 'keys',
      },
      {
        id: '4539cf1e45114b87',
        name: 'Pad',
        shortName: 'pad',
        type: 'popLowStringsLegato',
        lowLevelType: 'popLowStringsLegato',
        instrumentGroup: 'pads',
      },
    ],
    aiArtifacts: [],
  } as unknown as Song;
}

function makeBrainSongWithPadSingleNote(): Song {
  const base = makeBrainSongWithKeysAndPad();
  (base.arrangement.chorus1 as { overrides: Record<string, { bars: unknown[] }> }).overrides.Pad = {
    bars: [
      { notes: { '0.0': [{ type: 'note', note: 60, duration: 4 }] } },
      { notes: { '0.0': [{ type: 'note', note: 62, duration: 4 }] } },
      { notes: { '0.0': [{ type: 'note', note: 70, duration: 4 }] } },
      { notes: { '0.0': [{ type: 'note', note: 60, duration: 4 }] } },
    ],
  };
  return base;
}

describe('toEngineFixture (Keys + Pad)', () => {
  it('emits inst-3.json (Keys) and inst-4.json (Pad) when both families are active', () => {
    const fixture = toEngineFixture(makeBrainSongWithKeysAndPad(), {
      brainHash: HASH,
      generatorParams: PARAMS,
    });
    const filenames = fixture.instruments.map((i) => i.filename);
    expect(filenames).toContain('inst-1.json');
    expect(filenames).toContain('inst-3.json');
    expect(filenames).toContain('inst-4.json');
    expect(filenames).not.toContain('inst-2.json');

    const keys = fixture.instruments.find((i) => i.filename === 'inst-3.json')!.json as EmittedTonalInst;
    expect(keys.name).toBe('Keys');
    expect(keys.id).toBe(38907);
    expect(keys.type).toBe('keys');
    expect(keys.samples.length).toBe(17);

    const pad = fixture.instruments.find((i) => i.filename === 'inst-4.json')!.json as EmittedTonalInst;
    expect(pad.name).toBe('Pad');
    expect(pad.id).toBe(38972);
    expect(pad.type).toBe('synths');
    expect(pad.samples.length).toBe(17);
  });

  it('lowers brain Keys chord events with the default chordType voicing the engine requires', () => {
    const fixture = toEngineFixture(makeBrainSongWithKeysAndPad(), {
      brainHash: HASH,
      generatorParams: PARAMS,
    });
    const envelope = fixture.songJson as EmittedEnvelope;
    const keys = envelope.arrangement.chorus1!.overrides.Keys!;
    expect(keys.type).toBe('brainRoundtrip');
    expect(keys.bars).toHaveLength(4);
    const bar0 = keys.bars![0]!;
    expect(Object.keys(bar0.notes)).toEqual(['0.0']);
    const ev0 = bar0.notes['0.0']![0]! as { type: string; chord: string; chordType: string; duration: number };
    expect(ev0.type).toBe('chord');
    expect(ev0.chord).toBe('C');
    expect(ev0.chordType).toBe('oneOctaveMid');
    expect(ev0.duration).toBe(2);
    expect(
      keys.bars!.map((b) => (b.notes['0.0']![0] as { chord: string }).chord),
    ).toEqual(['C', 'Dm', 'A#9', 'C']);

    expect(envelope.arrangement.chorus1!.instruments.Keys).toBe(true);
  });

  it('lowers brain Pad chord events with the twoOctavesMid default voicing', () => {
    const fixture = toEngineFixture(makeBrainSongWithKeysAndPad(), {
      brainHash: HASH,
      generatorParams: PARAMS,
    });
    const envelope = fixture.songJson as EmittedEnvelope;
    const pad = envelope.arrangement.chorus1!.overrides.Pad!;
    expect(pad.bars).toHaveLength(4);
    for (const bar of pad.bars!) {
      const ev = bar.notes['0.0']![0]! as { type: string; chordType: string; duration: number };
      expect(ev.type).toBe('chord');
      expect(ev.chordType).toBe('twoOctavesMid');
      expect(ev.duration).toBe(4);
    }
    expect(envelope.arrangement.chorus1!.instruments.Pad).toBe(true);
  });

  it('lowers brain Pad single-note events to engine noteAbsolute strings', () => {
    const fixture = toEngineFixture(makeBrainSongWithPadSingleNote(), {
      brainHash: HASH,
      generatorParams: PARAMS,
    });
    const envelope = fixture.songJson as EmittedEnvelope;
    const pad = envelope.arrangement.chorus1!.overrides.Pad!;
    const noteNamesPerBar = pad.bars!.map((b) => {
      const ev = b.notes['0.0']![0] as { note: string };
      return ev.note;
    });
    expect(noteNamesPerBar).toEqual(['c4', 'd4', 'a#4', 'c4']);
    for (const bar of pad.bars!) {
      expect(bar.notes['0.0']![0]!.type).toBe('noteAbsolute');
    }
  });

  it('preserves a caller-supplied chordType on the brain event verbatim', () => {
    const song = makeBrainSongWithKeysAndPad();
    (song.arrangement.chorus1 as { overrides: Record<string, { bars: unknown[] }> })
      .overrides.Pad = {
      bars: [
        {
          notes: {
            '0.0': [{ type: 'chord', chord: 'C', chordType: 'oneOctaveHigh', duration: 4 }],
          },
        },
      ],
    };
    const fixture = toEngineFixture(song, { brainHash: HASH, generatorParams: PARAMS });
    const pad = (fixture.songJson as EmittedEnvelope).arrangement.chorus1!.overrides.Pad!;
    const ev = pad.bars![0]!.notes['0.0']![0] as { chordType: string };
    expect(ev.chordType).toBe('oneOctaveHigh');
  });

  it('emits Keys+Pad diagnostics with the chord-voicing defaults', () => {
    const fixture = toEngineFixture(makeBrainSongWithKeysAndPad(), {
      brainHash: HASH,
      generatorParams: PARAMS,
    });
    const paths = fixture.diagnostics.map((d) => d.path);
    expect(paths).toContain('overrides.Keys');
    expect(paths).toContain('overrides.Pad');
    expect(paths).toContain('instrumentDefinitions.Keys');
    expect(paths).toContain('instrumentDefinitions.Pad');
    expect(paths).toContain('assetResolver.Keys');
    expect(paths).toContain('assetResolver.Pad');
    const joined = fixture.diagnostics.map((d) => d.message).join('\n');
    expect(joined).toMatch(/Keys lowering: per-segment brain chord\/note events/);
    expect(joined).toMatch(/Pad lowering: per-segment brain chord\/note events/);
  });

  it('records wired resolver verdicts in diagnostics (resolved case for both families)', () => {
    const fixture = toEngineFixture(makeBrainSongWithKeysAndPad(), {
      brainHash: HASH,
      generatorParams: PARAMS,
      keysAssetResolution: {
        status: 'resolved',
        relativePath: 'keys/keysAcousticPiano/Grand.ogg',
        matchKind: 'canonical',
        entryId: '7f7952be598f9294',
      },
      padAssetResolution: {
        status: 'resolved',
        relativePath: 'pads/popLowStringsLegato/StringsLegato.ogg',
        matchKind: 'canonical',
        entryId: '4539cf1e45114b87',
      },
    });
    const keysDiag = fixture.diagnostics.find((d) => d.path === 'assetResolver.Keys')!;
    expect(keysDiag.severity).toBe('info');
    expect(keysDiag.message).toMatch(/resolved \(canonical\)/);
    expect(keysDiag.message).toContain('keys/keysAcousticPiano/Grand.ogg');

    const padDiag = fixture.diagnostics.find((d) => d.path === 'assetResolver.Pad')!;
    expect(padDiag.severity).toBe('info');
    expect(padDiag.message).toContain('pads/popLowStringsLegato/StringsLegato.ogg');
  });

  it('records an unresolved resolver verdict as a warning diagnostic', () => {
    const fixture = toEngineFixture(makeBrainSongWithKeysAndPad(), {
      brainHash: HASH,
      generatorParams: PARAMS,
      keysAssetResolution: {
        status: 'unresolved',
        reason: 'keys entry not in validated catalog',
        entryId: '7f7952be598f9294',
      },
    });
    const d = fixture.diagnostics.find((x) => x.path === 'assetResolver.Keys')!;
    expect(d.severity).toBe('warning');
    expect(d.message).toMatch(/unresolved/);
    expect(d.message).toContain('keys entry not in validated catalog');
  });

  it('is deterministic for the Keys+Pad-active input', () => {
    const a = toEngineFixture(makeBrainSongWithKeysAndPad(), {
      brainHash: HASH,
      generatorParams: PARAMS,
    });
    const b = toEngineFixture(makeBrainSongWithKeysAndPad(), {
      brainHash: HASH,
      generatorParams: PARAMS,
    });
    expect(JSON.stringify(a.songJson)).toBe(JSON.stringify(b.songJson));
    expect(JSON.stringify(a.instruments)).toBe(JSON.stringify(b.instruments));
    expect(JSON.stringify(a.diagnostics)).toBe(JSON.stringify(b.diagnostics));
  });

  it('Drums-only path stays byte-stable: no inst-3/inst-4 and no Keys/Pad arrangement when families are absent', () => {
    const fixture = toEngineFixture(makeBrainSong(), {
      brainHash: HASH,
      generatorParams: PARAMS,
    });
    const filenames = fixture.instruments.map((i) => i.filename);
    expect(filenames).toEqual(['inst-1.json']);
    const env = fixture.songJson as EmittedEnvelope;
    expect(env.arrangement.chorus1!.overrides.Keys).toBeUndefined();
    expect(env.arrangement.chorus1!.overrides.Pad).toBeUndefined();
    expect(env.arrangement.chorus1!.instruments.Keys).toBeUndefined();
    expect(env.arrangement.chorus1!.instruments.Pad).toBeUndefined();
    const paths = fixture.diagnostics.map((d) => d.path);
    expect(paths).toContain('overrides.Keys');
    expect(paths).toContain('overrides.Pad');
    const joined = fixture.diagnostics.map((d) => d.message).join('\n');
    expect(joined).toMatch(/Keys lowering skipped/);
    expect(joined).toMatch(/Pad lowering skipped/);
  });

  it('preserves Drums + Bass behavior when Keys/Pad are added', () => {
    const bassOnly = toEngineFixture(makeBrainSongWithBass(), {
      brainHash: HASH,
      generatorParams: PARAMS,
    });
    const both = makeBrainSongWithBass();
    (both.arrangement.chorus1 as { overrides: Record<string, { bars: unknown[] }> })
      .overrides.Keys = {
      bars: makeChordOverrideBars(['C', 'Dm', 'A#9', 'C'], 2),
    };
    (both.arrangement.chorus1 as { overrides: Record<string, { bars: unknown[] }> })
      .overrides.Pad = {
      bars: makeChordOverrideBars(['C', 'Dm', 'A#9', 'C'], 4),
    };
    (both.arrangement.chorus1 as { instruments: Record<string, boolean> })
      .instruments = { Drums: true, Bass: true, Keys: true, Pad: true };
    const withAll = toEngineFixture(both, { brainHash: HASH, generatorParams: PARAMS });

    const a = (bassOnly.songJson as EmittedEnvelope).arrangement.chorus1!;
    const b = (withAll.songJson as EmittedEnvelope).arrangement.chorus1!;
    expect(JSON.stringify(a.overrides.Drums)).toBe(JSON.stringify(b.overrides.Drums));
    expect(JSON.stringify(a.overrides.Bass)).toBe(JSON.stringify(b.overrides.Bass));
    expect(b.instruments.Drums).toBe(true);
    expect(b.instruments.Bass).toBe(true);
    expect(b.instruments.Keys).toBe(true);
    expect(b.instruments.Pad).toBe(true);

    const drumsA = bassOnly.instruments.find((i) => i.filename === 'inst-1.json')!.json;
    const drumsB = withAll.instruments.find((i) => i.filename === 'inst-1.json')!.json;
    expect(JSON.stringify(drumsA)).toBe(JSON.stringify(drumsB));
    const bassA = bassOnly.instruments.find((i) => i.filename === 'inst-2.json')!.json;
    const bassB = withAll.instruments.find((i) => i.filename === 'inst-2.json')!.json;
    expect(JSON.stringify(bassA)).toBe(JSON.stringify(bassB));
  });
});

// ---- Multi-segment lowering -------------------------------------------

function makeMultiSegmentBrainSong(): Song {
  // 5 brain segments — intro (silent), verse1 (Drums+Bass), preChorus1 (Drums+Bass+Keys),
  // chorus1 (Drums+Bass+Keys+Pad), outro (Pad only). Each segment carries its own bar
  // count, and `instruments.<Family>` explicitly toggles families on or off per segment.
  const drumBar = {
    notes: {
      '0.0': [{ type: 'note', note: 36, duration: 0.25 }],
      '1.0': [{ type: 'note', note: 38, duration: 0.25 }],
      '2.0': [{ type: 'note', note: 36, duration: 0.25 }],
      '3.0': [{ type: 'note', note: 38, duration: 0.25 }],
    },
  };
  const bassBar = (root: number) => ({
    notes: { '0.0': [{ type: 'note', note: root, duration: 1 }] },
  });
  const keysBar = (chord: string) => ({
    notes: { '0.0': [{ type: 'chord', chord, duration: 4 }] },
  });
  const padBar = (chord: string) => ({
    notes: { '0.0': [{ type: 'chord', chord, duration: 4 }] },
  });
  const chords4 = FOUR_BAR_CHORDS;
  const chords2 = chords4.slice(0, 2);
  const chords8 = [...chords4, ...chords4];
  return {
    schemaVersion: '1.0.0',
    key: 'C',
    bpm: 120,
    genre: 'brightPop',
    songStructure: [
      { name: 'intro', bars: chords2.map((chords) => ({ chords })) }, // 2 bars
      { name: 'verse1', bars: chords4.map((chords) => ({ chords })) }, // 4 bars
      { name: 'preChorus1', bars: chords2.map((chords) => ({ chords })) }, // 2 bars
      { name: 'chorus1', bars: chords8.map((chords) => ({ chords })) }, // 8 bars
      { name: 'outro', bars: chords2.map((chords) => ({ chords })) }, // 2 bars
    ],
    arrangement: {
      intro: {
        instruments: { Drums: false, Bass: false, Keys: false, Pad: false },
        overrides: {},
        fills: {},
        mutes: {},
        signalProcessors: {},
        transitions: {},
      },
      verse1: {
        instruments: { Drums: true, Bass: true, Keys: false, Pad: false },
        overrides: {
          Drums: { bars: [drumBar] },
          Bass: { bars: [bassBar(36), bassBar(38), bassBar(46), bassBar(36)] },
        },
        fills: {},
        mutes: {},
        signalProcessors: {},
        transitions: {},
      },
      preChorus1: {
        instruments: { Drums: true, Bass: true, Keys: true, Pad: false },
        overrides: {
          Drums: { bars: [drumBar] },
          Bass: { bars: [bassBar(36), bassBar(38)] },
          Keys: { bars: [keysBar('C'), keysBar('Dm')] },
        },
        fills: {},
        mutes: {},
        signalProcessors: {},
        transitions: {},
      },
      chorus1: {
        instruments: { Drums: true, Bass: true, Keys: true, Pad: true },
        overrides: {
          Drums: { bars: [drumBar] },
          Bass: {
            bars: chords8.map((c) => bassBar(c[0] === 'C' ? 36 : c[0] === 'Dm' ? 38 : 46)),
          },
          Keys: { bars: chords8.map((c) => keysBar(c[0]!)) },
          Pad: { bars: chords8.map((c) => padBar(c[0]!)) },
        },
        fills: {},
        mutes: {},
        signalProcessors: {},
        transitions: {},
      },
      outro: {
        instruments: { Drums: false, Bass: false, Keys: false, Pad: true },
        overrides: {
          Pad: { bars: [padBar('C'), padBar('C')] },
        },
        fills: {},
        mutes: {},
        signalProcessors: {},
        transitions: {},
      },
    },
    instrumentDefinitions: [],
    aiArtifacts: [],
  } as unknown as Song;
}

describe('toEngineFixture (multi-segment)', () => {
  it('emits every brain segment as an engine structure entry with the segment key (not name)', () => {
    const fixture = toEngineFixture(makeMultiSegmentBrainSong(), {
      brainHash: HASH,
      generatorParams: PARAMS,
    });
    const envelope = fixture.songJson as EmittedEnvelope;
    expect(envelope.structure).toHaveLength(5);
    expect(envelope.structure.map((s) => s.segment)).toEqual([
      'intro',
      'verse1',
      'preChorus1',
      'chorus1',
      'outro',
    ]);
    // Phase 2 contract: the per-entry key is `segment`, NOT `name`.
    // Make the contract explicit on every entry.
    for (const entry of envelope.structure) {
      expect(typeof entry.segment).toBe('string');
      expect((entry as unknown as { name?: string }).name).toBeUndefined();
    }
  });

  it('carries each segment\'s bar count into the engine structure entry', () => {
    const fixture = toEngineFixture(makeMultiSegmentBrainSong(), {
      brainHash: HASH,
      generatorParams: PARAMS,
    });
    const envelope = fixture.songJson as EmittedEnvelope;
    const barsBySeg = Object.fromEntries(
      envelope.structure.map((s) => [s.segment, s.bars.length]),
    );
    expect(barsBySeg).toEqual({
      intro: 2,
      verse1: 4,
      preChorus1: 2,
      chorus1: 8,
      outro: 2,
    });
    // Total bar count must grow vs the prior single-segment proof slice
    // (which only emitted chorus1's first 4 bars).
    const totalBars = envelope.structure.reduce((n, s) => n + s.bars.length, 0);
    expect(totalBars).toBe(18);
    expect(totalBars).toBeGreaterThan(4);
  });

  it('emits per-segment overrides for Drums/Bass/Keys/Pad where active', () => {
    const fixture = toEngineFixture(makeMultiSegmentBrainSong(), {
      brainHash: HASH,
      generatorParams: PARAMS,
    });
    const envelope = fixture.songJson as EmittedEnvelope;
    // verse1: Drums + Bass active only.
    const verse1 = envelope.arrangement.verse1!;
    expect(verse1.overrides.Drums).toBeDefined();
    expect(verse1.overrides.Bass).toBeDefined();
    expect(verse1.overrides.Keys).toBeUndefined();
    expect(verse1.overrides.Pad).toBeUndefined();
    expect(verse1.overrides.Drums!.type).toBe('brainRoundtrip');
    expect(verse1.overrides.Bass!.type).toBe('brainRoundtrip');

    // chorus1: all four families active.
    const chorus1 = envelope.arrangement.chorus1!;
    expect(chorus1.overrides.Drums).toBeDefined();
    expect(chorus1.overrides.Bass).toBeDefined();
    expect(chorus1.overrides.Keys).toBeDefined();
    expect(chorus1.overrides.Pad).toBeDefined();
    expect(chorus1.overrides.Bass!.bars).toHaveLength(8);
    expect(chorus1.overrides.Pad!.bars).toHaveLength(8);

    // outro: Pad only.
    const outro = envelope.arrangement.outro!;
    expect(outro.overrides.Pad).toBeDefined();
    expect(outro.overrides.Drums).toBeUndefined();
    expect(outro.overrides.Bass).toBeUndefined();
    expect(outro.overrides.Keys).toBeUndefined();
  });

  it('sets instruments.<Family> = false for inactive families so the engine does not auto-play them', () => {
    // isInstrumentInSegment defaults to TRUE on missing entries
    // (sequencer/Sequencer.cpp:45-47). We must list each emitted family
    // explicitly to silence it for a segment.
    const fixture = toEngineFixture(makeMultiSegmentBrainSong(), {
      brainHash: HASH,
      generatorParams: PARAMS,
    });
    const envelope = fixture.songJson as EmittedEnvelope;

    const intro = envelope.arrangement.intro!;
    expect(intro.instruments.Drums).toBe(false);
    expect(intro.instruments.Bass).toBe(false);
    expect(intro.instruments.Keys).toBe(false);
    expect(intro.instruments.Pad).toBe(false);

    const verse1 = envelope.arrangement.verse1!;
    expect(verse1.instruments.Drums).toBe(true);
    expect(verse1.instruments.Bass).toBe(true);
    expect(verse1.instruments.Keys).toBe(false);
    expect(verse1.instruments.Pad).toBe(false);

    const outro = envelope.arrangement.outro!;
    expect(outro.instruments.Drums).toBe(false);
    expect(outro.instruments.Bass).toBe(false);
    expect(outro.instruments.Keys).toBe(false);
    expect(outro.instruments.Pad).toBe(true);

    // Vocal is not emitted into the instruments map at all (deferred —
    // see docs/53z). On a missing entry, the engine's default-true is
    // safe because Vocal also has no instrument track added at addInstrument
    // time, so there's nothing to play.
    expect(intro.instruments.Vocal).toBeUndefined();
    expect(verse1.instruments.Vocal).toBeUndefined();
  });

  it('emits inst-N.json per family iff that family is active in at least one segment', () => {
    const fixture = toEngineFixture(makeMultiSegmentBrainSong(), {
      brainHash: HASH,
      generatorParams: PARAMS,
    });
    const filenames = fixture.instruments.map((i) => i.filename);
    expect(filenames).toEqual([
      'inst-1.json',
      'inst-2.json',
      'inst-3.json',
      'inst-4.json',
    ]);
  });

  it('emits empty fills/mutes/signalProcessors/transitions for every segment', () => {
    const fixture = toEngineFixture(makeMultiSegmentBrainSong(), {
      brainHash: HASH,
      generatorParams: PARAMS,
    });
    const envelope = fixture.songJson as EmittedEnvelope;
    for (const seg of envelope.structure) {
      const ar = envelope.arrangement[seg.segment]!;
      expect(ar.fills).toEqual({});
      expect(ar.mutes).toEqual({});
      expect(ar.signalProcessors).toEqual({});
      expect(ar.transitions).toEqual({});
    }
  });

  it('keeps tempo/bpm = brain bpm regardless of segment count', () => {
    const fixture = toEngineFixture(makeMultiSegmentBrainSong(), {
      brainHash: HASH,
      generatorParams: PARAMS,
    });
    const envelope = fixture.songJson as EmittedEnvelope;
    expect(envelope.tempo).toBe(120);
  });

  it('is byte-stable for the same seed (multi-segment input)', () => {
    const a = toEngineFixture(makeMultiSegmentBrainSong(), {
      brainHash: HASH,
      generatorParams: PARAMS,
    });
    const b = toEngineFixture(makeMultiSegmentBrainSong(), {
      brainHash: HASH,
      generatorParams: PARAMS,
    });
    expect(JSON.stringify(a.songJson)).toBe(JSON.stringify(b.songJson));
    expect(JSON.stringify(a.instruments)).toBe(JSON.stringify(b.instruments));
    expect(JSON.stringify(a.diagnostics)).toBe(JSON.stringify(b.diagnostics));
  });

  it('multi-segment diagnostic summarises every segment + active families', () => {
    const fixture = toEngineFixture(makeMultiSegmentBrainSong(), {
      brainHash: HASH,
      generatorParams: PARAMS,
    });
    const structureDiag = fixture.diagnostics.find((d) => d.path === 'structure')!;
    expect(structureDiag.message).toMatch(/Multi-segment lowering/);
    expect(structureDiag.message).toMatch(/5-segment songStructure/);
    expect(structureDiag.message).toMatch(/18 bar/);
    // Each segment is named in the per-segment summary.
    for (const name of ['intro', 'verse1', 'preChorus1', 'chorus1', 'outro']) {
      expect(structureDiag.message).toContain(name);
    }
    const vocalDiag = fixture.diagnostics.find(
      (d) => d.path === 'arrangement.instruments.Vocal',
    )!;
    expect(vocalDiag.action).toBe('dropped');
  });

  it('per-segment Drums override carries the brain MIDI hits for that segment', () => {
    const fixture = toEngineFixture(makeMultiSegmentBrainSong(), {
      brainHash: HASH,
      generatorParams: PARAMS,
    });
    const envelope = fixture.songJson as EmittedEnvelope;
    // verse1's drum bar fires kick on 0.0 and 2.0; snare on 1.0 and 3.0.
    const verse1 = envelope.arrangement.verse1!.overrides.Drums!.pattern!;
    expect(verse1.bassDrum1).toBe('x000000000000000x000000000000000');
    expect(verse1.snareDrum1).toBe('00000000x000000000000000x0000000');
  });

  it('per-segment Bass override carries the brain root-pitch progression for that segment', () => {
    const fixture = toEngineFixture(makeMultiSegmentBrainSong(), {
      brainHash: HASH,
      generatorParams: PARAMS,
    });
    const envelope = fixture.songJson as EmittedEnvelope;
    const verse1Bass = envelope.arrangement.verse1!.overrides.Bass!;
    expect(verse1Bass.bars).toHaveLength(4);
    const notes = verse1Bass.bars!.map(
      (b) => (b.notes['0.0']![0] as { note: string }).note,
    );
    expect(notes).toEqual(['c2', 'd2', 'a#2', 'c2']);
  });
});
