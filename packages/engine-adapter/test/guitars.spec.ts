// docs/54s — Guitar adapter wiring tests.
//
// Three layers tested:
// 1. `buildGuitarInst` — inst-N.json structural shape.
// 2. `guitarDefinition` — brain InstrumentDefinition filter.
// 3. `toEngineFixture` integration — orchestrate(brightPop) → adapter
//    → per-segment Guitar instruments flags + inst-5.json + override
//    chord events.

import { describe, expect, it } from 'vitest';
import { orchestrate, type GenerateParams } from '@casperaki/arrangement';
import type { Song } from '@casperaki/song-schema';

import { toEngineFixture } from '../src/index.js';
import {
  DEFAULT_GUITAR_FRET_NOISE_ID,
  DEFAULT_GUITAR_SAMPLE_ID_BASE,
  DEFAULT_GUITAR_STRUM_ID_BASE,
  DEFAULT_GUITAR_VST_ID,
  GUITAR_DISPLAY_NAME,
  buildGuitarInst,
  collectStrumPoolEntries,
  guitarDefinition,
} from '../src/guitars.js';

const POP_PARAMS: GenerateParams = {
  genre: 'brightPop',
  key: 'C',
  bpm: 120,
  seed: 'brightPop-vertical-slice',
};

// docs/58 lane model — guitar selection is probabilistic per genre, and the
// canonical brightPop slice no longer rosters a Guitar. This ballad seed
// rosters an acoustic Guitar that plays the legacy Virtual Guitarist bank
// (chord + virtualGuitarist + per-string strum events; approved pattern-lab
// guitar styles take the lane on other seeds), so the integration tests below
// run against it.
const GUITAR_PARAMS: GenerateParams = {
  genre: 'ballad',
  key: 'C',
  bpm: 75,
  seed: 'ballad-guitar-2',
};

/** Segment names where the Guitar lane is active in the lowered envelope. */
function guitarActiveSegments(envelope: {
  arrangement: Record<string, { instruments: Record<string, boolean> }>;
}): string[] {
  return Object.entries(envelope.arrangement)
    .filter(([, v]) => v.instruments[GUITAR_DISPLAY_NAME] === true)
    .map(([k]) => k);
}

const FAKE_DEF = {
  id: 'cat-id-1',
  name: 'Guitar',
  shortName: 'preset - foo',
  type: 'acousticGuitarsNylonStereo',
  lowLevelType: 'acousticGuitarsNylonStereo',
  instrumentGroup: 'acousticGuitars',
} as Parameters<typeof buildGuitarInst>[0]['def'];

describe('buildGuitarInst', () => {
  it('emits 30 per-note samples (15 long + 15 short) at the default id base', () => {
    const out = buildGuitarInst({ def: FAKE_DEF, filenameIndex: 5 });
    expect(out.json.samples.length).toBe(30);
    const longCount = out.json.samples.filter((s) => s.type === 'longNote').length;
    const shortCount = out.json.samples.filter((s) => s.type === 'shortNote').length;
    expect(longCount).toBe(15);
    expect(shortCount).toBe(15);
    expect(out.json.samples[0]!.id).toBe(DEFAULT_GUITAR_SAMPLE_ID_BASE);
    expect(out.sampleIdRange.start).toBe(DEFAULT_GUITAR_SAMPLE_ID_BASE);
    expect(out.sampleIdRange.endInclusive).toBe(DEFAULT_GUITAR_SAMPLE_ID_BASE + 29);
  });

  it('emits an 8-element fxFretNoise pool by default (docs/54t)', () => {
    const out = buildGuitarInst({ def: FAKE_DEF, filenameIndex: 5 });
    expect(out.json.fx.fxFretNoise.length).toBe(8);
    expect(out.json.fx.fxFretNoise).toEqual([
      DEFAULT_GUITAR_FRET_NOISE_ID,
      DEFAULT_GUITAR_FRET_NOISE_ID + 1,
      DEFAULT_GUITAR_FRET_NOISE_ID + 2,
      DEFAULT_GUITAR_FRET_NOISE_ID + 3,
      DEFAULT_GUITAR_FRET_NOISE_ID + 4,
      DEFAULT_GUITAR_FRET_NOISE_ID + 5,
      DEFAULT_GUITAR_FRET_NOISE_ID + 6,
      DEFAULT_GUITAR_FRET_NOISE_ID + 7,
    ]);
    expect(out.fretNoiseId).toBe(DEFAULT_GUITAR_FRET_NOISE_ID);
    expect(out.fretNoiseIds.length).toBe(8);
  });

  it('honours the legacy fretNoiseId override (54s back-compat)', () => {
    const out = buildGuitarInst({
      def: FAKE_DEF,
      filenameIndex: 5,
      fretNoiseId: 99999,
    });
    expect(out.json.fx.fxFretNoise).toEqual([99999]);
    expect(out.fretNoiseId).toBe(99999);
    expect(out.fretNoiseIds).toEqual([99999]);
  });

  it('emits an empty virtualGuitaristSamples array (strums deferred to a later slice)', () => {
    const out = buildGuitarInst({ def: FAKE_DEF, filenameIndex: 5 });
    expect(out.json.virtualGuitaristSamples).toEqual([]);
  });

  it('carries the correct top-level fields the engine Guitar class reads', () => {
    const out = buildGuitarInst({ def: FAKE_DEF, filenameIndex: 5 });
    expect(out.filename).toBe('inst-5.json');
    expect(out.json.id).toBe(DEFAULT_GUITAR_VST_ID);
    expect(out.json.name).toBe('Guitar');
    expect(out.json.type).toBe('acousticGuitars');
    expect(out.json.lowLevelType).toBe('acousticGuitarsNylonStereo');
    expect(out.json.isStrummer).toBe(true);
    expect(out.json.isVst).toBe(true);
    expect(out.json.isSample).toBe(false);
    expect(out.json.catalogId).toBe('cat-id-1');
  });

  // docs/54u — electric guitars share the same inst shape but emit
  // `type: 'electricGuitars'`. The brain orchestrator writes
  // `instrumentGroup = entry.family`; the adapter mirrors that into
  // the inst `type` + `instrumentGroup` fields.
  it('emits type=electricGuitars when the brain def is electric (docs/54u)', () => {
    const electricDef = {
      ...FAKE_DEF,
      type: 'electricGuitarsLpChorusStereo',
      lowLevelType: 'electricGuitarsLpChorusStereo',
      instrumentGroup: 'electricGuitars',
    } as typeof FAKE_DEF;
    const out = buildGuitarInst({ def: electricDef, filenameIndex: 5 });
    expect(out.json.type).toBe('electricGuitars');
    expect(out.json.instrumentGroup).toBe('electricGuitars');
    expect(out.json.lowLevelType).toBe('electricGuitarsLpChorusStereo');
    expect(out.json.samples.length).toBe(30);
    expect(out.json.fx.fxFretNoise.length).toBe(8);
    expect(out.json.isStrummer).toBe(true);
  });

  it('accepts caller-provided id base + fret-noise id overrides', () => {
    const out = buildGuitarInst({
      def: FAKE_DEF,
      filenameIndex: 7,
      vstId: 50000,
      sampleIdBase: 12000,
      fretNoiseId: 12999,
    });
    expect(out.json.id).toBe(50000);
    expect(out.json.samples[0]!.id).toBe(12000);
    expect(out.json.samples[29]!.id).toBe(12029);
    expect(out.json.fx.fxFretNoise).toEqual([12999]);
    expect(out.filename).toBe('inst-7.json');
  });
});

describe('guitarDefinition', () => {
  it('matches a brain Guitar def via instrumentGroup', () => {
    const fake = {
      schemaVersion: '1',
      key: 'C', bpm: 120, songStructure: [], arrangement: {},
      instrumentDefinitions: [
        { id: 1, name: 'Drums', type: 'drums' },
        { id: 'X', name: 'Guitar', type: 'acousticGuitarsSteelStereo', instrumentGroup: 'acousticGuitars' },
      ],
      aiArtifacts: [],
    } as unknown as Song;
    expect(guitarDefinition(fake)?.id).toBe('X');
  });

  it('matches electric guitars too (docs/54u)', () => {
    const fake = {
      schemaVersion: '1',
      key: 'C', bpm: 120, songStructure: [], arrangement: {},
      instrumentDefinitions: [
        { id: 'X', name: 'Guitar', type: 'electricGuitarsLpChorusStereo', instrumentGroup: 'electricGuitars' },
      ],
      aiArtifacts: [],
    } as unknown as Song;
    expect(guitarDefinition(fake)?.id).toBe('X');
  });

  it('returns undefined when no Guitar def is present', () => {
    const fake = {
      schemaVersion: '1',
      key: 'C', bpm: 120, songStructure: [], arrangement: {},
      instrumentDefinitions: [{ id: 1, name: 'Drums', type: 'drums' }],
      aiArtifacts: [],
    } as unknown as Song;
    expect(guitarDefinition(fake)).toBeUndefined();
  });
});

// docs/54v — strum pool collector.
describe('collectStrumPoolEntries', () => {
  // One structure bar per event, its four beats all carrying the event's
  // chord, and one pattern bar per event with the strum on beat 0 — the
  // engine reads the strum's chord from the structure bar, not the event.
  function songWithEvents(
    perSegmentEvents: Record<string, Array<{ chord: string; event: string; chordPosition?: string }>>,
  ): Song {
    return {
      schemaVersion: '1',
      key: 'C',
      bpm: 120,
      songStructure: Object.entries(perSegmentEvents).map(([name, evs]) => ({
        name,
        bars: evs.map((e) => ({ chords: [e.chord, e.chord, e.chord, e.chord] })),
      })),
      arrangement: Object.fromEntries(
        Object.entries(perSegmentEvents).map(([name, evs]) => [
          name,
          {
            instruments: { Guitar: true },
            overrides: {
              Guitar: {
                bars: evs.map((e) => ({
                  notes: {
                    '0.0': [{
                      type: 'virtualGuitarist',
                      chord: e.chord,
                      event: e.event,
                      ...(e.chordPosition !== undefined ? { chordPosition: e.chordPosition } : {}),
                    }],
                  },
                })),
              },
            },
            fills: {}, mutes: {}, signalProcessors: {}, transitions: {},
          },
        ]),
      ),
      instrumentDefinitions: [],
      aiArtifacts: [],
    } as unknown as Song;
  }

  it('returns empty when no virtualGuitarist events fire', () => {
    const song = songWithEvents({});
    expect(collectStrumPoolEntries(song)).toEqual([]);
  });

  it('collects unique (chord, chordPosition, type) triples', () => {
    const song = songWithEvents({
      chorus1: [
        { chord: 'C', event: 'chordShortStrumDown' },
        { chord: 'F', event: 'chordShortStrumDown' },
      ],
      chorus2: [
        { chord: 'C', event: 'chordShortStrumDown' }, // duplicate
        { chord: 'G', event: 'chordLongStrumDown' },
      ],
    });
    const pool = collectStrumPoolEntries(song);
    expect(pool.length).toBe(3);
    const triples = pool.map((p) => `${p.chord}|${p.chordPosition}|${p.type}`).sort();
    expect(triples).toEqual([
      'C|1|chordShortStrumDown',
      'F|1|chordShortStrumDown',
      'G|1|chordLongStrumDown',
    ]);
  });

  it('assigns sequential ids starting at DEFAULT_GUITAR_STRUM_ID_BASE', () => {
    const song = songWithEvents({
      chorus1: [
        { chord: 'C', event: 'chordShortStrumDown' },
        { chord: 'F', event: 'chordShortStrumDown' },
      ],
    });
    const pool = collectStrumPoolEntries(song);
    expect(pool[0]!.id).toBe(DEFAULT_GUITAR_STRUM_ID_BASE);
    expect(pool[1]!.id).toBe(DEFAULT_GUITAR_STRUM_ID_BASE + 1);
  });

  it('defaults chordPosition to "1" on missing field', () => {
    const song = songWithEvents({
      chorus1: [{ chord: 'C', event: 'chordShortStrumDown' }],
    });
    const pool = collectStrumPoolEntries(song);
    expect(pool[0]!.chordPosition).toBe('1');
    expect(typeof pool[0]!.chordPosition).toBe('string');
  });

  it('honours explicit chordPosition when set', () => {
    const song = songWithEvents({
      chorus1: [
        { chord: 'C', event: 'chordShortStrumDown', chordPosition: '3' },
      ],
    });
    const pool = collectStrumPoolEntries(song);
    expect(pool[0]!.chordPosition).toBe('3');
  });

  it('emits fx-style entries (docs/54y) with fx field set + chord placeholder', () => {
    const fake = {
      schemaVersion: '1',
      key: 'C', bpm: 120,
      songStructure: [{ name: 'chorus1', bars: [{ chords: ['C', 'C', 'C', 'C'] }] }],
      arrangement: {
        chorus1: {
          instruments: { Guitar: true },
          overrides: {
            Guitar: {
              bars: [{ notes: { '0.0': [{ type: 'virtualGuitarist', event: 'fx1' }] } }],
            },
          },
        },
      },
      instrumentDefinitions: [],
      aiArtifacts: [],
    } as unknown as Song;
    const pool = collectStrumPoolEntries(fake);
    expect(pool.length).toBe(1);
    expect(pool[0]!.fx).toBe('fx1');
    expect(pool[0]!.type).toBe('fx1');
    expect(pool[0]!.chord).toBe('C'); // placeholder
  });

  it('output is fx: null on chord-strum entries (54v back-compat)', () => {
    const song = songWithEvents({
      chorus1: [{ chord: 'C', event: 'chordShortStrumDown' }],
    });
    const pool = collectStrumPoolEntries(song);
    expect(pool[0]!.fx).toBeNull();
  });

  it('sorts chord entries before fx entries (54y)', () => {
    const fake = {
      schemaVersion: '1',
      key: 'C', bpm: 120,
      songStructure: [{ name: 'chorus1', bars: [{ chords: ['C', 'C', 'C', 'C'] }] }],
      arrangement: {
        chorus1: {
          instruments: { Guitar: true },
          overrides: {
            Guitar: {
              bars: [{
                notes: {
                  '0.0': [
                    { type: 'virtualGuitarist', event: 'fx2' },
                    { type: 'virtualGuitarist', chord: 'C', event: 'chordShortStrumDown' },
                    { type: 'virtualGuitarist', event: 'fx1' },
                  ],
                },
              }],
            },
          },
        },
      },
      instrumentDefinitions: [],
      aiArtifacts: [],
    } as unknown as Song;
    const pool = collectStrumPoolEntries(fake);
    expect(pool.length).toBe(3);
    expect(pool[0]!.fx).toBeNull(); // chord entry first
    expect(pool[0]!.type).toBe('chordShortStrumDown');
    expect(pool[1]!.fx).toBe('fx1'); // fx entries sorted by name
    expect(pool[2]!.fx).toBe('fx2');
  });
});

describe('buildGuitarInst — strum pool wiring (docs/54v)', () => {
  const FAKE_DEF_V = {
    id: 'cat-id-1',
    name: 'Guitar',
    shortName: 'preset - foo',
    type: 'acousticGuitarsNylonStereo',
    lowLevelType: 'acousticGuitarsNylonStereo',
    instrumentGroup: 'acousticGuitars',
  } as Parameters<typeof buildGuitarInst>[0]['def'];

  it('emits empty virtualGuitaristSamples when strumPool not supplied (54s back-compat)', () => {
    const out = buildGuitarInst({ def: FAKE_DEF_V, filenameIndex: 5 });
    expect(out.json.virtualGuitaristSamples).toEqual([]);
    expect(out.strumPool).toEqual([]);
  });

  it('emits the supplied strum-pool entries verbatim into virtualGuitaristSamples', () => {
    const pool = [
      { id: 9200, chord: 'C', chordPosition: '1', type: 'chordShortStrumDown', fx: null },
      { id: 9201, chord: 'F', chordPosition: '1', type: 'chordShortStrumDown', fx: null },
    ] as const;
    const out = buildGuitarInst({ def: FAKE_DEF_V, filenameIndex: 5, strumPool: pool });
    expect(out.json.virtualGuitaristSamples).toHaveLength(2);
    expect(out.json.virtualGuitaristSamples[0]).toEqual(pool[0]);
    expect(out.json.virtualGuitaristSamples[1]).toEqual(pool[1]);
    expect(out.strumPool).toHaveLength(2);
  });
});

describe('toEngineFixture — Guitar production wiring', () => {
  it('emits a Guitar inst-N.json when brain orchestrates guitar', () => {
    const song = orchestrate(GUITAR_PARAMS);
    const fixture = toEngineFixture(song, {
      brainHash: 'fake-hash',
      generatorParams: GUITAR_PARAMS,
    });
    // The adapter picks the inst type from the brain def's instrumentGroup
    // (acoustic vs electric). The ballad slice rosters an acoustic guitar.
    const guitarInsts = fixture.instruments.filter((f) => {
      const t = (f.json as { type?: string })?.type;
      return t === 'acousticGuitars' || t === 'electricGuitars';
    });
    expect(guitarInsts.length).toBe(1);
    const json = guitarInsts[0]!.json as {
      name: string;
      type: string;
      lowLevelType: string;
      samples: unknown[];
      fx: { fxFretNoise: number[] };
      isStrummer: boolean;
    };
    expect(json.name).toBe('Guitar');
    // The lowLevelType matches the chosen catalog row's lowLevel,
    // and the inst type matches its family.
    if (json.lowLevelType.startsWith('electricGuitars')) {
      expect(json.type).toBe('electricGuitars');
    } else {
      expect(json.type).toBe('acousticGuitars');
    }
    expect(json.samples.length).toBe(30);
    // 54t — pool grew from 1 dummy to 8 real slices.
    expect(json.fx.fxFretNoise.length).toBe(8);
    expect(json.isStrummer).toBe(true);
  });

  // docs/54v — virtualGuitarist pool wired end-to-end.
  it('emits a non-empty virtualGuitaristSamples pool when brain emits strum events', () => {
    const song = orchestrate(GUITAR_PARAMS);
    const fixture = toEngineFixture(song, {
      brainHash: 'fake-hash',
      generatorParams: GUITAR_PARAMS,
    });
    const inst = fixture.instruments.find((f) => {
      const t = (f.json as { type?: string })?.type;
      return t === 'acousticGuitars' || t === 'electricGuitars';
    })!;
    const pool = (inst.json as { virtualGuitaristSamples: Array<{ chord: string; type: string; fx: string | null }> })
      .virtualGuitaristSamples;
    expect(pool.length).toBeGreaterThan(0);
    // 54y — pool now also carries fx entries (54v was chord-strum only).
    const chordEntries = pool.filter((e) => e.fx === null);
    expect(chordEntries.length).toBeGreaterThan(0);
    for (const e of chordEntries) {
      expect(e.type).toMatch(/^chord(Long|Short)Strum(Up|Down)$/);
    }
    // The pool's chords are chords the song plays: each one's root is a root of the song's chords.
    const root = (c: string) => /^[A-G][#b]?/u.exec(c)?.[0];
    const songRoots = new Set(song.songStructure.flatMap((seg) => seg.bars.flatMap((b) => b.chords.map((c) => root(String(c))))));
    for (const e of chordEntries) expect(songRoots.has(root(e.chord)), e.chord).toBe(true);
  });

  it('lowers virtualGuitarist events into engine overrides on a Guitar-active segment', () => {
    const song = orchestrate(GUITAR_PARAMS);
    const fixture = toEngineFixture(song, {
      brainHash: 'fake-hash',
      generatorParams: GUITAR_PARAMS,
    });
    const envelope = fixture.songJson as {
      arrangement: Record<string, {
        instruments: Record<string, boolean>;
        overrides: Record<string, { bars?: Array<{ notes?: Record<string, Array<{ type: string }>> }> }>;
      }>;
    };
    let totalVgEvents = 0;
    for (const seg of guitarActiveSegments(envelope)) {
      const bars = envelope.arrangement[seg]!.overrides.Guitar?.bars ?? [];
      for (const bar of bars) {
        for (const events of Object.values(bar.notes ?? {})) {
          for (const ev of events) if (ev.type === 'virtualGuitarist') totalVgEvents++;
        }
      }
    }
    expect(totalVgEvents).toBeGreaterThan(0);
  });

  // docs/58 lane model — guitar activation is probabilistic per-segment,
  // not the old fixed preChorus/chorus/bridge table. The invariant: the
  // per-segment `instruments` flag matches override presence, and the lane
  // fires on at least one segment but not all.
  it('flags Guitar active iff the segment carries a Guitar override (probabilistic)', () => {
    const song = orchestrate(GUITAR_PARAMS);
    const fixture = toEngineFixture(song, {
      brainHash: 'fake-hash',
      generatorParams: GUITAR_PARAMS,
    });
    const envelope = fixture.songJson as {
      arrangement: Record<string, {
        instruments: Record<string, boolean>;
        overrides: Record<string, { bars?: Array<{ notes?: Record<string, unknown[]> }> }>;
      }>;
    };
    let activeCount = 0;
    let inactiveCount = 0;
    for (const [segName, payload] of Object.entries(envelope.arrangement)) {
      if (!(GUITAR_DISPLAY_NAME in payload.instruments)) continue;
      const isActive = payload.instruments[GUITAR_DISPLAY_NAME] === true;
      const hasOverride = Boolean(payload.overrides[GUITAR_DISPLAY_NAME]?.bars?.length);
      expect(isActive, `${segName} Guitar flag matches override presence`).toBe(hasOverride);
      if (isActive) activeCount++; else inactiveCount++;
    }
    expect(activeCount).toBeGreaterThan(0);
    expect(inactiveCount).toBeGreaterThan(0);
  });

  it('lowers Guitar chord events to engine chord+chordType shape', () => {
    // Generated guitars play the Virtual Guitarist pattern (strum and
    // virtualGuitarist events, as the legacy does); plain chord events still
    // occur in songs saved earlier, so put one in and check its lowering.
    const generated = orchestrate(GUITAR_PARAMS);
    const segName = generated.songStructure.find((seg) => generated.arrangement[seg.name]?.overrides?.['Guitar']?.bars?.length)!.name;
    const guitarPart = generated.arrangement[segName]!.overrides['Guitar']!;
    const firstBar = guitarPart.bars![0]!;
    const song = {
      ...generated,
      arrangement: {
        ...generated.arrangement,
        [segName]: {
          ...generated.arrangement[segName]!,
          overrides: {
            ...generated.arrangement[segName]!.overrides,
            Guitar: { ...guitarPart, bars: [{ ...firstBar, notes: { ...firstBar.notes, '0.0': [{ type: 'chord', chord: 'C', duration: 2 }] } }, ...guitarPart.bars!.slice(1)] },
          },
        },
      },
    } as typeof generated;
    const fixture = toEngineFixture(song, {
      brainHash: 'fake-hash',
      generatorParams: GUITAR_PARAMS,
    });
    const envelope = fixture.songJson as {
      arrangement: Record<string, {
        instruments: Record<string, boolean>;
        overrides: Record<string, { bars?: Array<{ notes?: Record<string, unknown[]> }> }>;
      }>;
    };
    // Locate the first chord event on any Guitar-active segment. (Beats may
    // also carry per-string `type:'strum'` events from the picked legacy
    // guitarPatterns.json bank row, so we find the chord event explicitly.)
    let chordEvent:
      | { type: string; chord?: string; chordType?: string; duration?: number }
      | undefined;
    for (const seg of guitarActiveSegments(envelope)) {
      const bars = envelope.arrangement[seg]!.overrides.Guitar?.bars ?? [];
      for (const bar of bars) {
        for (const events of Object.values(bar.notes ?? {})) {
          const ch = (events as Array<{ type: string; chordType?: string }>).find(
            (e) => e.type === 'chord',
          );
          if (ch) {
            chordEvent = ch;
            break;
          }
        }
        if (chordEvent) break;
      }
      if (chordEvent) break;
    }
    expect(chordEvent).toBeDefined();
    expect(chordEvent!.chordType).toBe('oneOctaveMid');
  });

  it('does NOT emit a Guitar inst when no segment carries Guitar events', () => {
    // Construct a fake song with a Guitar definition but no per-segment
    // overrides. The adapter should drop with the "no guitar events"
    // diagnostic and emit zero Guitar insts.
    const fake = {
      schemaVersion: '1',
      key: 'C', bpm: 120, genre: 'brightPop',
      songStructure: [{ name: 'intro', bars: [{ chords: ['C', 'C', 'C', 'C'] }] }],
      arrangement: { intro: { instruments: {}, overrides: {}, fills: {}, mutes: {}, signalProcessors: {}, transitions: {} } },
      instrumentDefinitions: [
        { id: 'X', name: 'Guitar', type: 'acousticGuitarsSteelStereo', instrumentGroup: 'acousticGuitars' },
      ],
      aiArtifacts: [],
    } as unknown as Song;
    const fixture = toEngineFixture(fake, {
      brainHash: 'fake-hash',
      generatorParams: { genre: 'brightPop' } as Record<string, unknown>,
    });
    const guitarInsts = fixture.instruments.filter(
      (f) => (f.json as { type?: string })?.type === 'acousticGuitars',
    );
    expect(guitarInsts.length).toBe(0);
    const diag = fixture.diagnostics.find((d) => d.path === 'arrangement.Guitar');
    expect(diag?.action).toBe('dropped');
  });
});

describe('toEngineFixture — Lane A per-string strum passthrough (docs/54x)', () => {
  it('emits type:"strum" events on every Guitar-active segment', () => {
    const song = orchestrate(GUITAR_PARAMS);
    const fixture = toEngineFixture(song, {
      brainHash: 'fake-hash',
      generatorParams: GUITAR_PARAMS,
    });
    const envelope = fixture.songJson as {
      arrangement: Record<string, {
        instruments: Record<string, boolean>;
        overrides: Record<string, { bars?: Array<{ notes?: Record<string, unknown[]> }> }>;
      }>;
    };
    let totalStrumEvents = 0;
    for (const [_segName, seg] of Object.entries(envelope.arrangement)) {
      if (seg.instruments.Guitar !== true) continue;
      const ov = seg.overrides.Guitar;
      if (!ov?.bars) continue;
      for (const bar of ov.bars) {
        for (const events of Object.values(bar.notes ?? {})) {
          for (const ev of events as Array<{ type?: string }>) {
            if (ev?.type === 'strum') totalStrumEvents++;
          }
        }
      }
    }
    expect(totalStrumEvents).toBeGreaterThan(0);
  });

  it('passes strings/offset/durations/velocities arrays through verbatim', () => {
    const song = orchestrate(GUITAR_PARAMS);
    const fixture = toEngineFixture(song, {
      brainHash: 'fake-hash',
      generatorParams: GUITAR_PARAMS,
    });
    const envelope = fixture.songJson as {
      arrangement: Record<string, {
        instruments: Record<string, boolean>;
        overrides: Record<string, { bars?: Array<{ notes?: Record<string, unknown[]> }> }>;
      }>;
    };
    let inspected = 0;
    for (const seg of Object.values(envelope.arrangement)) {
      if (seg.instruments.Guitar !== true) continue;
      const bars = seg.overrides.Guitar?.bars ?? [];
      for (const bar of bars) {
        for (const events of Object.values(bar.notes ?? {})) {
          for (const ev of events as Array<{
            type?: string;
            chord?: string;
            strings?: unknown;
            offset?: unknown;
            durations?: unknown;
            velocities?: unknown;
          }>) {
            if (ev?.type !== 'strum') continue;
            expect(typeof ev.chord).toBe('string');
            expect(Array.isArray(ev.strings)).toBe(true);
            expect(Array.isArray(ev.offset)).toBe(true);
            expect(Array.isArray(ev.durations)).toBe(true);
            expect(Array.isArray(ev.velocities)).toBe(true);
            expect((ev.strings as number[]).length).toBeGreaterThan(0);
            // Parallel arrays — every brain emission produces equal
            // lengths because guitar.ts copies them verbatim from the
            // legacy bank.
            expect((ev.offset as number[]).length).toBe((ev.strings as number[]).length);
            expect((ev.durations as number[]).length).toBe((ev.strings as number[]).length);
            expect((ev.velocities as number[]).length).toBe((ev.strings as number[]).length);
            inspected++;
            if (inspected >= 8) return;
          }
        }
      }
    }
    expect(inspected).toBeGreaterThan(0);
  });

  it('does NOT add strum events to non-Guitar segments', () => {
    const song = orchestrate(GUITAR_PARAMS);
    const fixture = toEngineFixture(song, {
      brainHash: 'fake-hash',
      generatorParams: GUITAR_PARAMS,
    });
    const envelope = fixture.songJson as {
      arrangement: Record<string, {
        instruments: Record<string, boolean>;
        overrides: Record<string, { bars?: Array<{ notes?: Record<string, unknown[]> }> }>;
      }>;
    };
    for (const seg of Object.values(envelope.arrangement)) {
      if (seg.instruments.Guitar === true) continue;
      const bars = seg.overrides.Guitar?.bars ?? [];
      for (const bar of bars) {
        for (const events of Object.values(bar.notes ?? {})) {
          for (const ev of events as Array<{ type?: string }>) {
            expect(ev?.type).not.toBe('strum');
          }
        }
      }
    }
  });
});

describe('collectStrumPoolEntries — keys match the engine strum lookup', () => {
  function song(
    segBars: string[][],
    patternBars: Array<Record<string, Array<Record<string, unknown>>>>,
  ): Song {
    return {
      schemaVersion: '1',
      key: 'C',
      bpm: 120,
      songStructure: [{ name: 'chorus1', bars: segBars.map((chords) => ({ chords })) }],
      arrangement: {
        chorus1: {
          instruments: { Guitar: true },
          overrides: { Guitar: { bars: patternBars.map((notes) => ({ notes })) } },
        },
      },
      instrumentDefinitions: [],
      aiArtifacts: [],
    } as unknown as Song;
  }
  const strum = (chord: string, event = 'chordShortStrumDown') => ({ type: 'virtualGuitarist', chord, event });
  const chordsOf = (s: Song) => collectStrumPoolEntries(s).map((e) => e.chord);

  it('collapses the chord type onto the shipped sample flavour and spells roots with sharps', () => {
    const s = song(
      [['Fmaj7', 'Fmaj7', 'Bbm9', 'Bbm9'], ['Ebsus', 'Ebsus', 'Gdim', 'D11'], ['E5', 'E5', 'C#m7b5', 'Abmaj13']],
      [
        { '0.0': [strum('Fmaj7')], '2.0': [strum('Bbm9')] },
        { '0.0': [strum('Ebsus')], '2.0': [strum('Gdim')], '3.0': [strum('D11')] },
        { '0.0': [strum('E5')], '2.5': [strum('C#m7b5')], '3.0': [strum('Abmaj13')] },
      ],
    );
    expect(chordsOf(s).sort()).toEqual(['A#m', 'C#m7', 'D#sus4', 'D9', 'E', 'F7', 'G', 'G#6'].sort());
  });

  it('takes the chord from the structure bar, not the event', () => {
    const s = song([['Fmaj7', 'Fmaj7', 'G', 'G']], [{ '0.0': [strum('C')], '2.0': [strum('Am')] }]);
    expect(chordsOf(s).sort()).toEqual(['F7', 'G']);
  });

  it('repeats the pattern bars over every structure bar of the segment', () => {
    const s = song([['C', 'C', 'C', 'C'], ['Dm7', 'Dm7', 'Dm7', 'Dm7'], ['Esus2', 'Esus2', 'Esus2', 'Esus2']], [
      { '1.0': [strum('C')] },
    ]);
    expect(chordsOf(s).sort()).toEqual(['C', 'Dm7', 'Esus2']);
  });

  it('rolls a beat key of 4 or more into the following bar, and past the end keys it as "C"', () => {
    const s = song([['G', 'G', 'G', 'G'], ['A7', 'A7', 'A7', 'A7']], [{ '4.5': [strum('G')] }]);
    // bar 0 + 4.5 beats → bar 1 beat 0 (A7); bar 1 + 4.5 → past the end.
    expect(chordsOf(s).sort()).toEqual(['A7', 'C']);
  });

  it('throws on a structure chord the engine cannot parse', () => {
    const s = song([['Fxyz', 'Fxyz', 'Fxyz', 'Fxyz']], [{ '0.0': [strum('F')] }]);
    expect(() => collectStrumPoolEntries(s)).toThrow(/type "xyz"/);
  });

  it('skips a segment where the lane is explicitly inactive', () => {
    const s = song([['C', 'C', 'C', 'C']], [{ '0.0': [strum('C')] }]);
    (s.arrangement as Record<string, { instruments: Record<string, boolean> }>).chorus1!.instruments.Guitar = false;
    expect(collectStrumPoolEntries(s)).toEqual([]);
  });
});
