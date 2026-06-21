import { describe, expect, it } from 'vitest';
import {
  fromBrainJsonb,
  fromEngineEnvelope,
  toBrainJsonb,
  toEngineEnvelope,
} from '../src/index.js';
import { allEngineFixtures, loadEngineWebTesterFixture } from './fixtures/index.js';

describe('engine adapter round-trip', () => {
  for (const fixture of allEngineFixtures()) {
    it(`canonical → engine preserves songStructure segments (${fixture.id})`, () => {
      const { song } = fromEngineEnvelope({
        song: fixture.song as Record<string, unknown>,
        instruments: fixture.instruments as Record<string, unknown>[],
      });
      const envelope = toEngineEnvelope(song);
      const reparsed = fromEngineEnvelope({
        song: envelope.song,
        instruments: envelope.instruments,
      });
      expect(reparsed.song.songStructure.map((s) => s.name)).toEqual(
        song.songStructure.map((s) => s.name),
      );
      expect(reparsed.song.bpm).toBe(song.bpm);
      expect(reparsed.song.key).toBe(song.key);
      expect(Object.keys(reparsed.song.arrangement).sort()).toEqual(
        Object.keys(song.arrangement).sort(),
      );
    });
  }
});

describe('engine adapter emits engine-readable field names', () => {
  it('toEngineEnvelope emits `tempo` and `structure` (legacy keys the Sequencer reads)', () => {
    const fixture = loadEngineWebTesterFixture();
    const { song } = fromEngineEnvelope({
      song: fixture.song as Record<string, unknown>,
      instruments: fixture.instruments as Record<string, unknown>[],
    });
    const envelope = toEngineEnvelope(song);
    expect(envelope.song).toHaveProperty('tempo');
    expect(envelope.song).toHaveProperty('structure');
    expect(envelope.song).not.toHaveProperty('bpm');
    expect(envelope.song).not.toHaveProperty('songStructure');
    expect(typeof envelope.song.tempo).toBe('number');
    expect(Array.isArray(envelope.song.structure)).toBe(true);
    const first = (envelope.song.structure as Array<Record<string, unknown>>)[0];
    expect(first).toHaveProperty('segment');
    expect(first).not.toHaveProperty('name');
  });
});

describe('engine adapter normalizes legacy aliases', () => {
  it("maps web-tester fixture's `structure` and `tempo`", () => {
    const fixture = loadEngineWebTesterFixture();
    const { song, diagnostics } = fromEngineEnvelope({
      song: fixture.song as Record<string, unknown>,
      instruments: fixture.instruments as Record<string, unknown>[],
    });
    expect(song.songStructure.length).toBeGreaterThan(0);
    expect(song.songStructure[0].name).toBeTypeOf('string');
    expect(typeof song.bpm).toBe('number');
    expect(diagnostics.some((d) => d.path === 'structure')).toBe(true);
    expect(diagnostics.some((d) => d.path === 'tempo')).toBe(true);
  });
});

describe('engine adapter preserves instrument definitions', () => {
  it('parses every inst-*.json from the web-tester fixture', () => {
    const fixture = loadEngineWebTesterFixture();
    const { song } = fromEngineEnvelope({
      song: fixture.song as Record<string, unknown>,
      instruments: fixture.instruments as Record<string, unknown>[],
    });
    expect(song.instrumentDefinitions.length).toBe(fixture.instruments.length);
    expect(song.instrumentDefinitions[0].name).toBeTypeOf('string');
  });
});

describe('brain adapter round-trip', () => {
  it('canonical → brain JSONB → canonical preserves musical core', () => {
    const fixture = loadEngineWebTesterFixture();
    const { song } = fromEngineEnvelope({
      song: fixture.song as Record<string, unknown>,
      instruments: fixture.instruments as Record<string, unknown>[],
    });
    const jsonb = toBrainJsonb(song);
    expect(jsonb.bpm).toBe(song.bpm);
    expect(jsonb).not.toHaveProperty('tempo');
    const { song: reparsed } = fromBrainJsonb(jsonb);
    expect(reparsed.bpm).toBe(song.bpm);
    expect(reparsed.key).toBe(song.key);
    expect(reparsed.songStructure.map((s) => s.name)).toEqual(
      song.songStructure.map((s) => s.name),
    );
  });
});
