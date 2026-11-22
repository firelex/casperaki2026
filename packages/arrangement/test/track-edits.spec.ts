// Sequencer track edits: change sound, new pattern, add track (edits/track-edits.ts).

import { describe, expect, it } from 'vitest';

import { canonicalStringifySong, type Song } from '@casperaki/song-schema';

import {
  editTrack,
  familySoundPool,
  loadPublicNames,
  orchestrate,
  TrackEditError,
  trackOptions,
} from '../src/index.js';

const base = (): Song => orchestrate({ genre: 'brightPop', key: 'C', bpm: 110, seed: 'track-edits-1' });

/** Everything a track owns in a song, for comparing tracks across songs. */
function trackSlice(song: Song, track: string): string {
  return JSON.stringify({
    def: song.instrumentDefinitions.find((d) => d.name === track) ?? null,
    segs: song.songStructure.map((s) => {
      const a = song.arrangement[s.name]!;
      return [a.instruments[track], a.overrides[track], a.fills[track], a.mutes[track], a.signalProcessors[track]];
    }),
  });
}
const tracks = (song: Song) => song.instrumentDefinitions.map((d) => d.name);
const otherTracksSame = (a: Song, b: Song, except: string) => {
  for (const t of tracks(a)) if (t !== except) expect(trackSlice(b, t), t).toBe(trackSlice(a, t));
};

describe('track edits', () => {
  it('changeSound swaps the sound and leaves every other track byte-identical', () => {
    const song = base();
    const def = song.instrumentDefinitions.find((d) => d.name === 'Bass')!;
    const other = familySoundPool('bass', 'brightPop').find((e) => e.id !== def.id)!;
    const { song: edited, track } = editTrack(song, { kind: 'changeSound', track: 'Bass', soundId: other.id });
    expect(track).toBe('Bass');
    expect(edited.instrumentDefinitions.find((d) => d.name === 'Bass')!.id).toBe(other.id);
    otherTracksSame(song, edited, 'Bass');
    // Same section structure, same transitions.
    expect(edited.songStructure).toEqual(song.songStructure);
  });

  it('changeSound rejects a sound of another family', () => {
    const song = base();
    const keysSound = familySoundPool('keys', 'brightPop')[0]!;
    expect(() => editTrack(song, { kind: 'changeSound', track: 'Bass', soundId: keysSound.id })).toThrow(TrackEditError);
  });

  it('newPattern changes only that track, and again on the next call', () => {
    const song = base();
    const once = editTrack(song, { kind: 'newPattern', track: 'Drums' }).song;
    expect(trackSlice(once, 'Drums')).not.toBe(trackSlice(song, 'Drums'));
    for (const t of tracks(song)) if (t !== 'Drums' && t !== 'Bass') expect(trackSlice(once, t), t).toBe(trackSlice(song, t));
    const twice = editTrack(once, { kind: 'newPattern', track: 'Drums' }).song;
    expect(trackSlice(twice, 'Drums')).not.toBe(trackSlice(once, 'Drums'));
  });

  it('newPattern on a tonal track keeps every other track identical', () => {
    const song = base();
    const tonal = tracks(song).find((t) => !['Drums', 'Bass', 'Vocal', 'Backing vocals 1', 'Backing vocals 2', 'Loop'].includes(t))!;
    const edited = editTrack(song, { kind: 'newPattern', track: tonal }).song;
    otherTracksSame(song, edited, tonal);
  });

  it('addTrack adds a track to exactly the given sections', () => {
    const song = base();
    const sections = song.songStructure.map((s) => s.name);
    const chosen = sections.filter((n) => n.startsWith('chorus'));
    expect(chosen.length).toBeGreaterThan(0);
    const { song: edited, track } = editTrack(song, { kind: 'addTrack', family: 'keys', segments: chosen });
    expect(tracks(song)).not.toContain(track);
    expect(track).toMatch(/^Keys( \d+)?$/u);
    for (const n of sections) {
      const a = edited.arrangement[n]!;
      expect(a.instruments[track], n).toBe(chosen.includes(n));
      expect(a.overrides[track] !== undefined, n).toBe(chosen.includes(n));
    }
    otherTracksSame(song, edited, track);
  });

  it('addTrack follows client-side structure edits (duplicated section, more bars)', () => {
    const song = base();
    const verse = song.songStructure.find((s) => s.name.startsWith('verse'))!;
    const longer = { ...verse, name: 'verseCopy', bars: [...verse.bars, ...verse.bars] };
    const working: Song = {
      ...song,
      songStructure: [...song.songStructure, longer],
      arrangement: { ...song.arrangement, verseCopy: structuredClone(song.arrangement[verse.name]!) },
    };
    const { song: edited, track } = editTrack(working, { kind: 'addTrack', family: 'pad', segments: ['verseCopy'] });
    expect(edited.arrangement.verseCopy!.overrides[track]!.bars).toHaveLength(longer.bars.length);
    expect(edited.arrangement[verse.name]!.instruments[track]).toBe(false);
  });

  it('the drum kit cannot be chosen (it follows the genre)', () => {
    const song = base();
    expect(trackOptions(song).families.find((f) => f.family === 'drums')!.sounds).toEqual([]);
    const kick = familySoundPool('drums', 'brightPop')[0]!;
    expect(() => editTrack(song, { kind: 'changeSound', track: 'Drums', soundId: kick.id })).toThrow(/drum kit follows the genre/u);
  });

  it('adding drums to a song whose drum track was removed brings it back', () => {
    const song = base();
    const working: Song = {
      ...song,
      instrumentDefinitions: song.instrumentDefinitions.filter((d) => d.name !== 'Drums'),
      arrangement: Object.fromEntries(
        Object.entries(song.arrangement).map(([k, a]) => {
          const { Drums: _i, ...instruments } = a.instruments;
          const { Drums: _o, ...overrides } = a.overrides;
          const { Drums: _f, ...fills } = a.fills;
          const { Drums: _s, ...signalProcessors } = a.signalProcessors;
          return [k, { ...a, instruments, overrides, fills, signalProcessors }];
        }),
      ),
    };
    const first = song.songStructure[0]!.name;
    const { song: edited, track } = editTrack(working, { kind: 'addTrack', family: 'drums', segments: [first] });
    expect(track).toBe('Drums');
    expect(edited.arrangement[first]!.overrides.Drums).toEqual(song.arrangement[first]!.overrides.Drums);
    expect(edited.arrangement[song.songStructure[1]!.name]!.instruments.Drums).toBe(false);
  });

  it('a second drum track is refused (the engine plays one kit)', () => {
    const song = base();
    expect(() => editTrack(song, { kind: 'addTrack', family: 'drums', segments: [song.songStructure[0]!.name] })).toThrow(/one drum kit/u);
  });

  it('is deterministic, and replaying the generator block reproduces the edited song', () => {
    const song = base();
    const run = () => {
      let s = editTrack(song, { kind: 'newPattern', track: 'Drums' }).song;
      s = editTrack(s, { kind: 'addTrack', family: 'keys', segments: [s.songStructure[1]!.name] }).song;
      return s;
    };
    const a = run();
    expect(canonicalStringifySong(run(), 2)).toBe(canonicalStringifySong(a, 2));
    const g = a.generator!.params as { genre: string; key: string; bpm: number; params: Record<string, unknown> };
    const replay = orchestrate({ genre: g.genre, key: g.key, bpm: g.bpm, seed: a.generator!.seed!, params: g.params });
    expect(canonicalStringifySong(replay, 2)).toBe(canonicalStringifySong(a, 2));
  });

  it('options list public names only, and every track', () => {
    const song = base();
    const opts = trackOptions(song);
    for (const t of tracks(song)) expect(opts.tracks[t]).toBeDefined();
    expect(opts.tracks.Vocal?.editable).toBe(false);
    expect(opts.tracks.Bass).toMatchObject({ family: 'bass', editable: true });
    const publicNames = new Set(loadPublicNames().values());
    for (const f of opts.families) {
      for (const s of f.sounds) expect(publicNames.has(s.name), `${f.family} ${s.name}`).toBe(true);
    }
    expect(opts.families.map((f) => f.label)).toContain('Drums');
  });

  it('a song without a generator block answers 409', () => {
    const song = base();
    const { generator: _g, ...bare } = song;
    expect(() => editTrack(bare as Song, { kind: 'newPattern', track: 'Drums' })).toThrow(
      expect.objectContaining({ status: 409 }),
    );
  });
});
