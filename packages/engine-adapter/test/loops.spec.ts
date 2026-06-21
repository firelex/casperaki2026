// docs/54r — tests for Loop (percussionLoops) production wiring.
//
// Three layers covered:
// 1. `loopDefinitions` — InstrumentDefinition filter.
// 2. `buildLoopInst` — inst-N.json shape.
// 3. End-to-end `toEngineFixture` integration: orchestrate(brightPop)
//    → adapter → per-segment instruments[Loop] flags + inst file.

import { describe, expect, it } from 'vitest';
import {
  orchestrate,
  type GenerateParams,
} from '@casperaki/arrangement';
import type { Song } from '@casperaki/song-schema';

import { toEngineFixture } from '../src/index.js';
import {
  buildLoopInst,
  loopDefinitions,
  normalizeLoopLowLevelType,
  segmentHasLoopActive,
} from '../src/loops.js';

const POP_PARAMS: GenerateParams = {
  genre: 'brightPop',
  key: 'C',
  bpm: 120,
  seed: 'brightPop-vertical-slice',
};

describe('loopDefinitions', () => {
  it('returns the single Loop definition the brain orchestrator emits', () => {
    const song = orchestrate(POP_PARAMS);
    const loops = loopDefinitions(song);
    expect(loops.length).toBe(1);
    expect(loops[0]!.name).toBe('Loop');
    expect(loops[0]!.type).toBe('percussionLoops');
  });

  it('returns empty when the song carries no percussionLoops definition', () => {
    const fake = {
      schemaVersion: '1',
      key: 'C',
      bpm: 120,
      songStructure: [],
      arrangement: {},
      instrumentDefinitions: [
        { id: 1, name: 'Drums', type: 'drums' },
        { id: 2, name: 'Vocal', type: 'VocaloidPlaceholder' },
      ],
      aiArtifacts: [],
    } as unknown as Song;
    expect(loopDefinitions(fake)).toEqual([]);
  });

  it("accepts the bare 'percussion' type alias (engine table includes both)", () => {
    const fake = {
      schemaVersion: '1',
      key: 'C',
      bpm: 120,
      songStructure: [],
      arrangement: {},
      instrumentDefinitions: [
        { id: 'X', name: 'Loop', type: 'percussion' },
      ],
      aiArtifacts: [],
    } as unknown as Song;
    expect(loopDefinitions(fake).length).toBe(1);
  });
});

describe('buildLoopInst', () => {
  const fakeSong = { bpm: 120 } as unknown as Song;
  const def = {
    id: 'cat-id-1',
    name: 'Loop',
    shortName: 'preset - foo',
    type: 'percussionLoops',
    lowLevelType: 'percussionLoopsAcoustic_120-150bpm',
    instrumentGroup: 'percussion',
    isSample: true,
    isVst: false,
    details: { bpm: 120 },
  } as unknown as Parameters<typeof buildLoopInst>[0]['def'];

  it('emits filename, type, urls, details.bpm, details.duration', () => {
    const out = buildLoopInst({
      song: fakeSong,
      playsampleId: 50001,
      filenameIndex: 5,
      def,
      durationSeconds: 2.4,
      sourcePath: 'percussionLoops/foo.mp3',
    });
    expect(out.filename).toBe('inst-5.json');
    expect(out.blockKey).toBe('Loop');
    expect(out.json.id).toBe(50001);
    expect(out.json.name).toBe('Loop');
    expect(out.json.shortName).toBe('preset - foo');
    expect(out.json.type).toBe('percussionLoops');
    // The catalog's bpm-range suffix is stripped: the engine volume table
    // and family map key on the bare type (casperaki_engine FX.h).
    expect(out.json.lowLevelType).toBe('percussionLoopsAcoustic');
    expect(out.json.isSample).toBe(true);
    expect(out.json.isVst).toBe(false);
    expect(out.json.details.bpm).toBe(120);
    expect(out.json.details.duration).toBe(2.4);
    expect(out.json.urls).toEqual(['/playSample/50001']);
    expect(out.json.sourcePath).toBe('percussionLoops/foo.mp3');
    expect(out.json.catalogId).toBe('cat-id-1');
  });

  it('falls back to song.bpm when def.details.bpm is missing', () => {
    const out = buildLoopInst({
      song: fakeSong,
      playsampleId: 50001,
      filenameIndex: 5,
      def: { ...def, details: {} } as typeof def,
      durationSeconds: 1.0,
    });
    expect(out.json.details.bpm).toBe(120);
  });

  it('accepts string-encoded bpm (legacy-shaped data)', () => {
    const out = buildLoopInst({
      song: fakeSong,
      playsampleId: 50001,
      filenameIndex: 5,
      def: { ...def, details: { bpm: '100' } } as typeof def,
      durationSeconds: 1.0,
    });
    expect(out.json.details.bpm).toBe(100);
  });
});

describe('normalizeLoopLowLevelType', () => {
  it('strips the catalog bpm-range suffix the engine taxonomy omits', () => {
    expect(normalizeLoopLowLevelType('percussionLoopsAcoustic_120-150bpm')).toBe(
      'percussionLoopsAcoustic',
    );
    expect(normalizeLoopLowLevelType('percussionLoopsAcoustic_60-89bpm')).toBe(
      'percussionLoopsAcoustic',
    );
    expect(normalizeLoopLowLevelType('percussionLoopsElectronic_90-119bpm')).toBe(
      'percussionLoopsElectronic',
    );
  });

  it('leaves an already-bare lowLevelType untouched', () => {
    expect(normalizeLoopLowLevelType('percussionLoopsElectronic')).toBe(
      'percussionLoopsElectronic',
    );
  });

  it('only strips a trailing range suffix, not a mid-string match', () => {
    expect(normalizeLoopLowLevelType('foo_120-150bpmBar')).toBe(
      'foo_120-150bpmBar',
    );
  });
});

describe('toEngineFixture — Loop production wiring', () => {
  it('without a probe, brain Loop definition is dropped with a diagnostic', () => {
    const song = orchestrate(POP_PARAMS);
    const fixture = toEngineFixture(song, {
      brainHash: 'fake-hash',
      generatorParams: POP_PARAMS,
    });
    const loopInsts = fixture.instruments.filter(
      (f) => (f.json as { type?: string })?.type === 'percussionLoops',
    );
    expect(loopInsts.length).toBe(0);
    const diag = fixture.diagnostics.find((d) => d.path === 'arrangement.loops');
    expect(diag).toBeDefined();
    expect(diag?.severity).toBe('warning');
    expect(diag?.message).toMatch(/no loopSampleProbe/);
  });

  it('with a probe, emits one inst-N.json and per-segment instruments[Loop] flags', () => {
    const song = orchestrate(POP_PARAMS);
    const fixture = toEngineFixture(song, {
      brainHash: 'fake-hash',
      generatorParams: POP_PARAMS,
      loopSampleProbe: (def) => ({
        durationSeconds: 2.0,
        sourcePath: `library/${String(def.id)}.mp3`,
      }),
    });
    const loopInsts = fixture.instruments.filter(
      (f) => (f.json as { type?: string })?.type === 'percussionLoops',
    );
    expect(loopInsts.length).toBe(1);
    const inst = loopInsts[0]!.json as {
      id: number;
      name: string;
      type: string;
      details: { bpm: number; duration: number };
      urls: string[];
    };
    expect(inst.name).toBe('Loop');
    expect(inst.details.bpm).toBe(120);
    expect(inst.details.duration).toBe(2.0);
    expect(inst.urls).toEqual([`/playSample/${inst.id}`]);

    // Per-segment instruments[Loop] flag is the brain's loopActive
    // (verse-only for brightPop). At least one segment should be true,
    // and intro / outro / chorus / preChorus / break should all be false
    // (the legacy verse-only rule).
    const envelope = fixture.songJson as {
      arrangement: Record<string, { instruments: Record<string, boolean> }>;
    };
    const trueSegments: string[] = [];
    const falseSegments: string[] = [];
    for (const [segName, payload] of Object.entries(envelope.arrangement)) {
      if (!(inst.name in payload.instruments)) continue;
      if (payload.instruments[inst.name] === true) trueSegments.push(segName);
      else falseSegments.push(segName);
    }
    expect(trueSegments.length).toBeGreaterThan(0);
    expect(falseSegments.length).toBeGreaterThan(0);
    for (const segName of trueSegments) expect(segName).toMatch(/^verse/);
    for (const segName of falseSegments) expect(segName).not.toMatch(/^verse/);
  });

  it('dropped probe (null duration) emits a diagnostic but does not throw', () => {
    const song = orchestrate(POP_PARAMS);
    const fixture = toEngineFixture(song, {
      brainHash: 'fake-hash',
      generatorParams: POP_PARAMS,
      loopSampleProbe: () => ({
        durationSeconds: null,
        reason: 'no library mounted',
      }),
    });
    const loopInsts = fixture.instruments.filter(
      (f) => (f.json as { type?: string })?.type === 'percussionLoops',
    );
    expect(loopInsts.length).toBe(0);
    const diag = fixture.diagnostics.find((d) => d.path === 'arrangement.loops');
    expect(diag?.message).toMatch(/no library mounted/);
  });
});

describe('segmentHasLoopActive', () => {
  it('returns true only on an explicit instruments[loopName]=true', () => {
    const song = {
      schemaVersion: '1',
      key: 'C',
      bpm: 120,
      songStructure: [],
      arrangement: {
        verse1: { instruments: { Loop: true } },
        chorus1: { instruments: { Loop: false } },
        bridge1: { instruments: {} }, // missing key
      },
      instrumentDefinitions: [],
      aiArtifacts: [],
    } as unknown as Song;
    expect(segmentHasLoopActive(song, 'verse1', 'Loop')).toBe(true);
    expect(segmentHasLoopActive(song, 'chorus1', 'Loop')).toBe(false);
    expect(segmentHasLoopActive(song, 'bridge1', 'Loop')).toBe(false);
    expect(segmentHasLoopActive(song, 'unknown', 'Loop')).toBe(false);
  });
});
