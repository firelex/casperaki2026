// Rap like singing (docs/superpowers/specs/2026-11-28-rap-like-singing-design.md): rap words in the song, rap clips on
// the "Rap" track per section, sung takes muted where there is rap, clips muted and unmuted by hand.
import { RAP_TRACK, vocalTakeFingerprint, type Song } from '@casperaki/song-schema';
import { describe, expect, it } from 'vitest';

import {
  applyAceLayer,
  applyRapLyrics,
  applySungVocals,
  applySungVocalsOver,
  muteUnderRap,
  orchestrate,
  rapLyricsOf,
  rapSections,
  setTakesMuted,
  sungSections,
  type AceLayerResult,
  type SungTake,
} from '../src/index.js';

const base = orchestrate({ genre: 'brightPop', key: 'C', bpm: 110, seed: 'a' });
const sung = sungSections(base).map((s) => s.name);
const [s1, s2] = [sung[0]!, sung[1]!];
const sha = (c: string) => c.repeat(64);
const take = (segment: string, track: string, n: string): SungTake => ({
  segment, track, kind: 'soulx-vocal', sha256: sha(n), durationSeconds: 8, modelId: 'soulx', modelVersion: 'v1', seed: 1,
});
const rap = (sections: readonly string[], n = 'e', track = RAP_TRACK): AceLayerResult => ({
  track,
  instrument: 'rap',
  caption: 'pop song with male rap vocals',
  seed: 3,
  takes: sections.map((s) => ({ segment: s, sha256: sha(n), durationSeconds: 8, fingerprint: vocalTakeFingerprint(base, s, track) as never })),
  rapLyrics: Object.fromEntries(sections.map((s) => [s, [`${s} line ${n}`]])),
});
const sungAll = applySungVocals(base, { melody: {}, takes: [take(s1, 'Vocal', 'a'), take(s1, 'Backing vocals 1', 'b'), take(s2, 'Vocal', 'c')] });
// s1's melody as the generator made it (a sung result carries the melody of the sections it sang).
const melodyOf = (section: string) =>
  base.arrangement[section]!.overrides['Vocal']!.bars!.flatMap((b, bi) =>
    Object.entries(b.notes ?? {}).flatMap(([beat, evs]) =>
      (evs ?? []).map((e) => {
        const ev = e as { note: number; duration: number; fullWord?: string };
        return { start: bi * 4 + Number.parseFloat(beat), duration: ev.duration, midi: ev.note, word: 'La', phonemes: ['l', 'aa1'] };
      }),
    ),
  );
const takeOf = (song: Song, segment: string, track: string) =>
  song.aiArtifacts.find((a) => a.attachedTo.scope === 'segment' && a.attachedTo.segment === segment && a.attachedTo.instrument === track)!;

describe('rap lyrics', () => {
  it('are kept per section, merged with earlier ones', () => {
    const once = applyRapLyrics(base, { [s1]: ['one line', 'two line'] });
    const twice = applyRapLyrics(once, { [s2]: ['three'] });
    expect(rapLyricsOf(twice)).toEqual({ [s1]: ['one line', 'two line'], [s2]: ['three'] });
    expect(rapLyricsOf(base)).toEqual({});
  });

  it('refuse an unknown section or empty lines', () => {
    expect(() => applyRapLyrics(base, { nowhere: ['x'] })).toThrow(/no section "nowhere"/u);
    expect(() => applyRapLyrics(base, { [s1]: [] })).toThrow(/no lines/u);
  });
});

describe('rap clips', () => {
  it('land on "Rap", replacing only the clips of their own sections', () => {
    const first = applyAceLayer(base, rap([s1, s2], 'e'));
    const again = applyAceLayer(first, rap([s2], 'f'));
    const clips = again.aiArtifacts.filter((a) => a.attachedTo.scope === 'segment' && a.attachedTo.instrument === RAP_TRACK);
    expect(clips.map((a) => [(a.attachedTo as { segment: string }).segment, a.output.sha256])).toEqual([[s1, sha('e')], [s2, sha('f')]]);
    expect(rapSections(again)).toEqual([s1, s2]);
    // the words each section was rapped with are the song's rap lyrics
    expect(rapLyricsOf(again)).toEqual({ [s1]: [`${s1} line e`], [s2]: [`${s2} line f`] });
  });

  it('refuse a rap result on another track', () => {
    expect(() => applyAceLayer(base, rap([s1], 'e', 'ACE Rap'))).toThrow(/"Rap" track/u);
  });

  it('mute the sung takes (lead and backing) of their sections, and only those', () => {
    const song = applyAceLayer(sungAll, rap([s1]));
    expect(takeOf(song, s1, 'Vocal').muted).toBe(true);
    expect(takeOf(song, s1, 'Backing vocals 1').muted).toBe(true);
    expect(takeOf(song, s2, 'Vocal').muted).toBeUndefined();
    expect(takeOf(song, s1, RAP_TRACK).muted).toBeUndefined();
  });
});

describe('Sing after rap', () => {
  it('mutes its new takes in rap sections; a take unmuted by hand elsewhere stays unmuted', () => {
    const rapped = applyAceLayer(sungAll, rap([s1, s2]));
    const unmuted = setTakesMuted(rapped, 'Vocal', s2, false);
    expect(takeOf(unmuted, s2, 'Vocal').muted).toBeUndefined();
    const resung = applySungVocals(unmuted, { melody: { [s1]: melodyOf(s1) }, takes: [take(s1, 'Vocal', 'd')] }, { partial: true });
    expect(takeOf(resung, s1, 'Vocal').muted).toBe(true);
    expect(takeOf(resung, s2, 'Vocal').muted).toBeUndefined();
  });
});

describe('setTakesMuted and muteUnderRap', () => {
  it('mute and unmute every take of a track in a section', () => {
    const muted = setTakesMuted(sungAll, 'Vocal', s1, true);
    expect(takeOf(muted, s1, 'Vocal').muted).toBe(true);
    expect('muted' in takeOf(setTakesMuted(muted, 'Vocal', s1, false), s1, 'Vocal')).toBe(false);
  });

  it('refuse a track and section with no take', () => {
    expect(() => setTakesMuted(sungAll, 'Vocal', 'nowhere', true)).toThrow(/no take/u);
  });

  it('muteUnderRap leaves sections without rap alone', () => {
    expect(muteUnderRap(sungAll, [s1])).toEqual(sungAll);
  });
});

describe('review fixes 2026-11-28', () => {
  it('rapping a section again on a song rapped before (its clips on "ACE Rap") replaces the old clip there', () => {
    const old = applyAceLayer(base, { ...rap([s1, s2], 'e', 'Rap'), track: 'Rap' });
    // the same clips as an 11-27 song had them: on "ACE Rap"
    const legacy = { ...old, aiArtifacts: old.aiArtifacts.map((a) => (a.attachedTo.scope === 'segment' ? { ...a, attachedTo: { ...a.attachedTo, instrument: 'ACE Rap' } } : a)) } as Song;
    const again = applyAceLayer(legacy, rap([s1], 'f'));
    const clips = again.aiArtifacts.filter((a) => a.attachedTo.scope === 'segment').map((a) => `${a.attachedTo.instrument}@${(a.attachedTo as { segment: string }).segment}`);
    expect(clips.sort()).toEqual([`ACE Rap@${s2}`, `Rap@${s1}`].sort());
  });

  it('a muted rap clip is no rap: Sing there is not muted', () => {
    const rapped = setTakesMuted(applyAceLayer(sungAll, rap([s1])), RAP_TRACK, s1, true);
    expect(rapSections(rapped)).toEqual([]);
    const resung = applySungVocals(rapped, { melody: { [s1]: melodyOf(s1) }, takes: [take(s1, 'Vocal', 'd')] }, { partial: true });
    expect(takeOf(resung, s1, 'Vocal').muted).toBeUndefined();
  });

  it('a Sing landing into unsaved edits keeps their mute toggles', () => {
    const saved = applyAceLayer(sungAll, rap([s1]));
    const working = setTakesMuted(saved, 'Vocal', s1, false); // unmuted by hand, not saved
    const result = { melody: { [s2]: melodyOf(s2) }, takes: [take(s2, 'Vocal', 'd')] };
    const savedSung = applySungVocals(saved, result, { partial: true });
    const merged = applySungVocalsOver(working, result, savedSung, { partial: true });
    expect(takeOf(merged, s1, 'Vocal').muted).toBeUndefined();
    expect(takeOf(merged, s1, 'Backing vocals 1').muted).toBe(true);
  });
});
