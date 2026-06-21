// docs/54z — Synths adapter wiring tests.

import { describe, expect, it } from 'vitest';
import { orchestrate, type GenerateParams } from '@casperaki/arrangement';
import type { Song } from '@casperaki/song-schema';

import { toEngineFixture } from '../src/index.js';
import {
  DEFAULT_SYNTHS_SAMPLE_ID_BASE,
  DEFAULT_SYNTHS_VST_ID,
  SYNTHS_DISPLAY_NAME,
  buildSynthsInst,
  synthsDefinition,
} from '../src/synths.js';

const POP_PARAMS: GenerateParams = {
  genre: 'brightPop',
  key: 'C',
  bpm: 120,
  seed: 'brightPop-vertical-slice',
};

const FAKE_SYNTHS_DEF = {
  id: 'cat-id-1',
  name: 'Synths',
  shortName: 'omnisphere - test',
  type: 'leadSynthsBright',
  lowLevelType: 'leadSynthsBright',
  instrumentGroup: 'leadSynths',
} as Parameters<typeof buildSynthsInst>[0]['def'];

describe('buildSynthsInst', () => {
  it('emits 17 long-note multisamples at the padAndSynthNotes grid', () => {
    const out = buildSynthsInst({ def: FAKE_SYNTHS_DEF, filenameIndex: 6 });
    expect(out.json.samples.length).toBe(17);
    for (const s of out.json.samples) expect(s.type).toBe('longNote');
    const notes = out.json.samples.map((s) => s.note).join(',');
    expect(notes).toBe(
      'c2,d#2,f#2,a2,c3,d#3,f#3,a3,c4,d#4,f#4,a4,c5,d#5,f#5,a5,c6',
    );
  });

  it('sets the engine-recognised type=leadSynths regardless of the catalog lowLevel', () => {
    const out = buildSynthsInst({ def: FAKE_SYNTHS_DEF, filenameIndex: 6 });
    expect(out.json.type).toBe('leadSynths');
    expect(out.json.instrumentGroup).toBe('leadSynths');
    expect(out.json.lowLevelType).toBe('leadSynthsBright');
  });

  it('places sample ids at the default base 4000 with vst wrapper id 39140', () => {
    const out = buildSynthsInst({ def: FAKE_SYNTHS_DEF, filenameIndex: 6 });
    expect(out.json.id).toBe(DEFAULT_SYNTHS_VST_ID);
    expect(out.json.samples[0]!.id).toBe(DEFAULT_SYNTHS_SAMPLE_ID_BASE);
    expect(out.json.samples[16]!.id).toBe(DEFAULT_SYNTHS_SAMPLE_ID_BASE + 16);
    expect(out.sampleIdRange).toEqual({ start: 4000, endInclusive: 4016 });
  });

  it('every sample references the inst wrapper vst id', () => {
    const out = buildSynthsInst({ def: FAKE_SYNTHS_DEF, filenameIndex: 6 });
    for (const s of out.json.samples) expect(s.vst).toBe(out.json.id);
  });

  it('honours overridden vstId and sampleIdBase', () => {
    const out = buildSynthsInst({
      def: FAKE_SYNTHS_DEF,
      filenameIndex: 6,
      vstId: 99999,
      sampleIdBase: 5000,
    });
    expect(out.json.id).toBe(99999);
    expect(out.json.samples[0]!.id).toBe(5000);
    expect(out.sampleIdRange).toEqual({ start: 5000, endInclusive: 5016 });
  });
});

describe('synthsDefinition', () => {
  it('finds a Synths definition with instrumentGroup leadSynths', () => {
    const song = {
      instrumentDefinitions: [
        { id: 'X', name: 'Pad', instrumentGroup: 'popStrings' },
        { id: 'Y', name: 'Synths', instrumentGroup: 'leadSynths' },
      ],
    } as unknown as Song;
    const def = synthsDefinition(song);
    expect(def?.id).toBe('Y');
  });

  it('ignores non-Synths definitions even if their lowLevel matches', () => {
    const song = {
      instrumentDefinitions: [
        { id: 'X', name: 'Pad', lowLevelType: 'leadSynthsBright', instrumentGroup: 'popStrings' },
      ],
    } as unknown as Song;
    expect(synthsDefinition(song)).toBeUndefined();
  });
});

describe('toEngineFixture — Synths production wiring (docs/54z)', () => {
  it('emits a Synths inst-N.json when brain orchestrates synths', () => {
    const song = orchestrate(POP_PARAMS);
    const fixture = toEngineFixture(song, {
      brainHash: 'fake-hash',
      generatorParams: POP_PARAMS,
    });
    const synthsInst = fixture.instruments.find(
      (f) => (f.json as { type?: string })?.type === 'leadSynths',
    );
    expect(synthsInst).toBeDefined();
    expect((synthsInst!.json as { samples: unknown[] }).samples.length).toBe(17);
  });

  // docs/58 lane model — Synths activation is probabilistic per-segment now
  // (not the old fixed preChorus/chorus/bridge table). The invariant the
  // adapter must hold: a lane's per-segment `instruments` flag is `true`
  // exactly when that segment carries a non-empty Synths override, and the
  // lane fires on at least one segment but not all of them.
  it('flags Synths active iff the segment carries a Synths override (probabilistic)', () => {
    const song = orchestrate(POP_PARAMS);
    const fixture = toEngineFixture(song, {
      brainHash: 'fake-hash',
      generatorParams: POP_PARAMS,
    });
    const envelope = fixture.songJson as {
      arrangement: Record<
        string,
        {
          instruments: Record<string, boolean>;
          overrides: Record<string, { bars?: Array<{ notes?: Record<string, unknown[]> }> }>;
        }
      >;
    };
    let activeCount = 0;
    let inactiveCount = 0;
    for (const [segName, payload] of Object.entries(envelope.arrangement)) {
      if (!(SYNTHS_DISPLAY_NAME in payload.instruments)) continue;
      const isActive = payload.instruments[SYNTHS_DISPLAY_NAME] === true;
      const hasOverride = Boolean(payload.overrides[SYNTHS_DISPLAY_NAME]?.bars?.length);
      expect(isActive, `${segName}: instruments flag must match override presence`).toBe(
        hasOverride,
      );
      if (isActive) activeCount++;
      else inactiveCount++;
    }
    expect(activeCount).toBeGreaterThan(0);
    expect(inactiveCount).toBeGreaterThan(0);
  });

  // docs/58 lane model — duplicate-family lanes (Synths 2 / Synths 3) are
  // now emitted as their own inst-N.json with unique wrapper ids, instead
  // of being silently dropped by the old fixed display-name scan.
  it('emits a separate inst for each duplicate leadSynths lane (Synths 2 / Synths 3)', () => {
    const song = orchestrate(POP_PARAMS);
    const fixture = toEngineFixture(song, {
      brainHash: 'fake-hash',
      generatorParams: POP_PARAMS,
    });
    const leadSynthLanes = fixture.instruments.filter(
      (f) => (f.json as { type?: string })?.type === 'leadSynths',
    );
    const names = leadSynthLanes.map((f) => (f.json as { name: string }).name);
    // The canonical brightPop slice rosters at least Synths + Synths 2.
    expect(names).toContain('Synths');
    expect(names).toContain('Synths 2');
    // Every emitted lane has a unique wrapper id (no clobbering).
    const ids = leadSynthLanes.map((f) => (f.json as { id: number }).id);
    expect(new Set(ids).size).toBe(ids.length);
    // …and a unique inst-N.json filename.
    const files = leadSynthLanes.map((f) => f.filename);
    expect(new Set(files).size).toBe(files.length);
  });

  // docs/55a — canonical seed now picks EDMSynthsStabs (piano-bank
  // path) for Synths; the EDMArpeggiator-specific test below is
  // skipped for the canonical seed. The piano-bank-path tests live
  // in packages/arrangement/test/synths-pattern.spec.ts.
  it.skip('passes EDMArpeggiator events through tonalBarsFromBrainBars verbatim (54z baseline; superseded by 55a)', () => {
    const song = orchestrate(POP_PARAMS);
    const fixture = toEngineFixture(song, {
      brainHash: 'fake-hash',
      generatorParams: POP_PARAMS,
    });
    interface ArpEv {
      type: string;
      chord?: string;
      arpeggioType?: string;
      numberOfOctaves?: number;
      duration?: number;
      noteDuration?: number;
    }
    const envelope = fixture.songJson as {
      arrangement: Record<string, {
        instruments: Record<string, boolean>;
        overrides: Record<string, { bars?: Array<{ notes?: Record<string, ArpEv[]> }> }>;
      }>;
    };
    const chorus1 = envelope.arrangement.chorus1!;
    expect(chorus1.instruments.Synths).toBe(true);
    const ov = chorus1.overrides.Synths;
    expect(ov?.bars?.length).toBe(8);
    const bar0events = ov!.bars![0]!.notes!['0.0']!;
    const arp = bar0events.find((e) => e.type === 'EDMArpeggiator');
    expect(arp).toBeDefined();
    expect(typeof arp!.chord).toBe('string');
    expect(typeof arp!.arpeggioType).toBe('string');
    expect([2, 3]).toContain(arp!.numberOfOctaves);
    expect(arp!.duration).toBe(0.25);
    expect(arp!.noteDuration).toBe(0.25);
  });
});
