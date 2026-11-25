import { describe, expect, it } from 'vitest';
import {
  AIArtifactKindSchema,
  SUNG_TAKE_KINDS,
  isTakeFresh,
  vocalTakeFingerprint,
  type AIArtifact,
  type Song,
} from '../src/index.js';

function makeSong(): Song {
  return {
    schemaVersion: 1,
    key: 'C',
    bpm: 100,
    songStructure: [
      { name: 'verse', bars: [{ chords: ['C', 'C', 'G', 'G'] }, { chords: ['Am', 'Am', 'F', 'F'] }] },
      { name: 'chorus', bars: [{ chords: ['F', 'F', 'C', 'C'] }] },
    ],
    arrangement: {
      verse: {
        instruments: {},
        overrides: {
          Vocal: { bars: [{ notes: [{ pitch: 60, words: 'la' }] }] },
          Bass: { bars: [{ notes: [{ pitch: 36 }] }] },
        },
        fills: {},
        mutes: {},
        signalProcessors: {},
        transitions: {},
      },
      chorus: { instruments: {}, overrides: {}, fills: {}, mutes: {}, signalProcessors: {}, transitions: {} },
    },
    patterns: {},
    instrumentDefinitions: [],
    aiArtifacts: [],
  } as unknown as Song;
}

const fp = (s: Song, seg = 'verse', track = 'Vocal') => vocalTakeFingerprint(s, seg, track);

describe('vocalTakeFingerprint', () => {
  it('is a sha256 hex and stable', () => {
    expect(fp(makeSong())).toMatch(/^[a-f0-9]{64}$/);
    expect(fp(makeSong())).toBe(fp(makeSong()));
  });
  it('changes with chords, notes, words, bpm', () => {
    const base = fp(makeSong());
    const chord = makeSong();
    (chord.songStructure[0]!.bars[0] as { chords: string[] }).chords[0] = 'D';
    expect(fp(chord)).not.toBe(base);
    const pitch = makeSong();
    (pitch.arrangement.verse!.overrides.Vocal as any).bars[0].notes[0].pitch = 62;
    expect(fp(pitch)).not.toBe(base);
    const words = makeSong();
    (words.arrangement.verse!.overrides.Vocal as any).bars[0].notes[0].words = 'da';
    expect(fp(words)).not.toBe(base);
    const bpm = makeSong();
    (bpm as { bpm: number }).bpm = 101;
    expect(fp(bpm)).not.toBe(base);
  });
  it('ignores other tracks and other segments', () => {
    const base = fp(makeSong());
    const other = makeSong();
    (other.arrangement.verse!.overrides.Bass as any).bars[0].notes[0].pitch = 40;
    (other.songStructure[1]!.bars[0] as { chords: string[] }).chords[0] = 'G';
    expect(fp(other)).toBe(base);
  });
  it('treats a missing lane as null and throws on an unknown segment', () => {
    expect(fp(makeSong(), 'chorus')).toMatch(/^[a-f0-9]{64}$/);
    expect(() => fp(makeSong(), 'bridge')).toThrow(/bridge/);
  });
});

describe('isTakeFresh', () => {
  const artifact = (song: Song): AIArtifact => ({
    id: 't1',
    kind: 'yue2-vocal',
    modelId: 'm',
    modelVersion: 'v',
    conditioning: { hashes: [fp(song) as never] },
    output: { uri: 'x.wav', sha256: 'a'.repeat(64) as never },
    attachedTo: { scope: 'segment', segment: 'verse', instrument: 'Vocal' },
  });
  it('is true for a matching hash and false after a chord edit', () => {
    const song = makeSong();
    const a = artifact(song);
    expect(isTakeFresh(song, a)).toBe(true);
    (song.songStructure[0]!.bars[0] as { chords: string[] }).chords[0] = 'D';
    expect(isTakeFresh(song, a)).toBe(false);
  });
  it('throws when the artifact has no fingerprint or no segment attachment', () => {
    const song = makeSong();
    expect(() => isTakeFresh(song, { ...artifact(song), conditioning: undefined })).toThrow(/hashes/);
    expect(() => isTakeFresh(song, { ...artifact(song), attachedTo: { scope: 'song' } })).toThrow(/segment/);
  });
});

describe('kinds', () => {
  it('accepts yue2-vocal', () => {
    expect(AIArtifactKindSchema.parse('yue2-vocal')).toBe('yue2-vocal');
    expect(SUNG_TAKE_KINDS).toEqual(['yue2-vocal', 'soulx-vocal']);
  });
});
