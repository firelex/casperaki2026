import { vocalTakeFingerprint } from '@casperaki/song-schema';
import { describe, expect, it } from 'vitest';

import { applyAceLayer, orchestrate, type AceLayerResult } from '../src/index.js';

const SONG = orchestrate({ genre: 'brightPop', key: 'C', bpm: 120, seed: 'ace-layer' });
const sha = (c: string) => c.repeat(64);
const layer = (track = 'ACE Guitar', s = 'a'): AceLayerResult => ({
  track,
  instrument: 'guitar',
  caption: 'acoustic guitar, 120 bpm, C major',
  seed: 7,
  takes: SONG.songStructure.slice(0, 2).map((x) => ({ segment: x.name, sha256: sha(s), durationSeconds: 8, fingerprint: vocalTakeFingerprint(SONG, x.name, track) as never })),
});

describe('applyAceLayer', () => {
  it('puts one clip per section on the layer track, stamped with the fingerprint it was played over', () => {
    const song = applyAceLayer(SONG, layer());
    const clips = song.aiArtifacts.filter((a) => a.kind === 'ace-step-conditioned');
    expect(clips.map((a) => (a.attachedTo as { segment: string }).segment)).toEqual(SONG.songStructure.slice(0, 2).map((x) => x.name));
    expect(clips.every((a) => a.attachedTo.scope === 'segment' && a.attachedTo.instrument === 'ACE Guitar')).toBe(true);
    expect(clips[0]!.conditioning?.hashes?.[0]).toBe(vocalTakeFingerprint(SONG, SONG.songStructure[0]!.name, 'ACE Guitar'));
    expect(clips[0]!.output.uri).toBe(`vocal-take:${sha('a')}.ogg`);
  });

  it('a new result for the same track replaces its clips; another ACE track keeps its own', () => {
    const twice = applyAceLayer(applyAceLayer(applyAceLayer(SONG, layer()), layer('ACE Guitar 2', 'c')), layer('ACE Guitar', 'b'));
    const of = (track: string) => twice.aiArtifacts.filter((a) => a.attachedTo.scope === 'segment' && a.attachedTo.instrument === track);
    expect(of('ACE Guitar').map((a) => a.output.sha256)).toEqual([sha('b'), sha('b')]);
    expect(of('ACE Guitar 2')).toHaveLength(2);
  });

  it('refuses a track name that is not an ACE layer of the instrument, or an unknown section', () => {
    expect(() => applyAceLayer(SONG, layer('Guitar'))).toThrow(/not a track name/u);
    expect(() => applyAceLayer(SONG, { ...layer(), takes: [{ ...layer().takes[0]!, segment: 'nowhere' }] })).toThrow(/no section "nowhere"/u);
  });
});
