import { describe, expect, it } from 'vitest';

import { addSection, drumKit, DRUM_ROLES, editTrack, loadValidatedCatalog, orchestrate, songDrumSounds } from '../src/index.js';

const otherSnare = (genre: string) => {
  const def = drumKit(genre).find((s) => s.role === 'snareDrum1')!.entry!.id;
  return loadValidatedCatalog().entries.find((e) => e.family === 'snareDrums' && e.id !== def)!.id;
};

describe('drum kit', () => {
  it('has the 17 engine roles with a sound each by default', () => {
    const kit = drumKit('brightPop');
    expect(kit.map((s) => s.role)).toEqual(DRUM_ROLES);
    expect(kit.every((s) => s.entry && !s.overridden)).toBe(true);
  });

  it('setDrumSound replaces one drum, survives other edits, and can be reset', () => {
    const song = orchestrate({ genre: 'brightPop', key: 'C', bpm: 120, seed: 'drum-kit-1' });
    const snare = otherSnare('brightPop');
    const { song: edited } = editTrack(song, { kind: 'setDrumSound', role: 'snareDrum1', soundId: snare });
    expect(songDrumSounds(edited)).toEqual({ snareDrum1: snare });
    expect(drumKit('brightPop', songDrumSounds(edited)).find((s) => s.role === 'snareDrum1')).toMatchObject({ overridden: true, entry: { id: snare } });
    // Parts are untouched.
    expect(edited.arrangement).toEqual(song.arrangement);
    // A new drum pattern (Drums regenerated) and a new section keep it.
    const { song: repat } = editTrack(edited, { kind: 'newPattern', track: 'Drums' });
    expect(songDrumSounds(repat)).toEqual({ snareDrum1: snare });
    const { song: added } = addSection(repat, 'bridge', 1);
    expect(songDrumSounds(added)).toEqual({ snareDrum1: snare });
    const { song: reset } = editTrack(added, { kind: 'setDrumSound', role: 'snareDrum1', soundId: null });
    expect(songDrumSounds(reset)).toEqual({});
  });

  it('rejects a sound of the wrong family and unknown roles', () => {
    const song = orchestrate({ genre: 'brightPop', key: 'C', bpm: 120, seed: 'drum-kit-2' });
    const kick = drumKit('brightPop').find((s) => s.role === 'bassDrum1')!.entry!.id;
    expect(() => editTrack(song, { kind: 'setDrumSound', role: 'snareDrum1', soundId: kick })).toThrow(/kickDrums sound/);
    expect(() => editTrack(song, { kind: 'setDrumSound', role: 'cowbell', soundId: kick })).toThrow(/Unknown drum/);
  });
});
