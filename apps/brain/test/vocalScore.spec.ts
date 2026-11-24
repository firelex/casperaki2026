import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SongSchema, type Song } from '@casperaki/song-schema';
import { describe, expect, it } from 'vitest';

import { sectionScore, soulxPhones, takeFingerprint } from '../src/vocals/score.js';

const GOLDEN = resolve(dirname(fileURLToPath(import.meta.url)), '../../../packages/arrangement/test/fixtures/golden/orchestrate/brightPop/brightPop-vertical-slice.song.json');
const golden = (): Song => SongSchema.parse(JSON.parse(readFileSync(GOLDEN, 'utf8')));

/** The golden's lead vocal notes of a section, in order: start beat within the section and MIDI note. */
function vocalNotes(song: Song, segment: string): { beat: number; note: number }[] {
  const out: { beat: number; note: number }[] = [];
  (song.arrangement[segment]?.overrides?.['Vocal']?.bars ?? []).forEach((bar, i) => {
    for (const [b, evs] of Object.entries(bar.notes ?? {})) {
      for (const e of evs as { type: string; note: number }[]) if (e.type === 'vocalNote') out.push({ beat: i * 4 + Number(b), note: e.note });
    }
  });
  return out.sort((a, b) => a.beat - b.beat);
}

describe('soulxPhones', () => {
  it('turns ARPAbet into one SoulX English syllable', () => {
    expect(soulxPhones(['k', 'ih0', 'ng'])).toBe('en_K-IH0-NG');
    expect(() => soulxPhones([])).toThrow(/no phonemes/);
  });
});

describe('sectionScore', () => {
  const song = golden();
  const secPerBeat = 60 / song.bpm;
  const bars = (seg: string) => song.songStructure.find((s) => s.name === seg)!.bars.length;

  it('sings the section notes as written, in lyric lines, rests as <SP>', () => {
    const score = sectionScore(song, 'verse1')!;
    expect(score.lengthSec).toBeCloseTo(bars('verse1') * 4 * secPerBeat, 6);
    const sung = score.phrases.flatMap((p) => p.notePitch.filter((n) => n > 0));
    expect(sung).toEqual(vocalNotes(song, 'verse1').map((n) => n.note));
    let lastEnd = 0;
    for (const p of score.phrases) {
      expect(p.phoneme.length).toBe(p.duration.length);
      expect(p.notePitch.length).toBe(p.duration.length);
      expect(p.noteType.length).toBe(p.duration.length);
      p.phoneme.forEach((ph, i) => {
        if (ph === '<SP>') expect([p.notePitch[i], p.noteType[i]]).toEqual([0, 1]);
        else expect([p.notePitch[i]! > 0, p.noteType[i], ph.startsWith('en_')]).toEqual([true, 2, true]);
      });
      expect(p.startSec).toBeGreaterThanOrEqual(lastEnd - 1e-9);
      lastEnd = p.startSec + p.duration.reduce((a, b) => a + b, 0);
      expect(lastEnd).toBeLessThanOrEqual(score.lengthSec + 1e-9);
      // A phrase's notes lie in one 4-bar lyric line.
      const firstNote = p.startSec + (p.phoneme[0] === '<SP>' ? p.duration[0]! : 0);
      const line = Math.floor(firstNote / (16 * secPerBeat) + 1e-9);
      expect(lastEnd).toBeLessThanOrEqual((line + 1) * 16 * secPerBeat + 1e-6);
    }
  });

  it('a section without lead vocal notes has no score', () => {
    const silent = song.songStructure.find((s) => vocalNotes(song, s.name).length === 0);
    if (silent) expect(sectionScore(song, silent.name)).toBeUndefined();
    const copy = structuredClone(song);
    delete copy.arrangement['verse1']!.overrides!['Vocal'];
    expect(sectionScore(copy, 'verse1')).toBeUndefined();
  });

  it('a sung note without phonemes is an error naming the section and bar', () => {
    const copy = structuredClone(song);
    const bar = copy.arrangement['verse1']!.overrides!['Vocal']!.bars![1]!;
    for (const evs of Object.values(bar.notes ?? {})) for (const e of evs as { vocaloidPhonemes?: string[] }[]) delete e.vocaloidPhonemes;
    expect(() => sectionScore(copy, 'verse1')).toThrow(/verse1 bar 2/);
  });
});

describe('takeFingerprint', () => {
  const song = golden();
  const fp = (s: Song, seg: string, voice = 'en_prompt', take = 1) => takeFingerprint(sectionScore(s, seg)!, voice, take);

  it('is the same for sections sung alike and changes with voice, take, tempo and key', () => {
    expect(fp(song, 'verse1')).toBe(fp(song, 'verse2'));
    expect(fp(song, 'verse1')).toMatch(/^[0-9a-f]{64}$/u);
    expect(fp(song, 'verse1', 'zh_target')).not.toBe(fp(song, 'verse1'));
    expect(fp(song, 'verse1', 'en_prompt', 2)).not.toBe(fp(song, 'verse1'));
    expect(fp({ ...song, bpm: song.bpm + 1 } as Song, 'verse1')).not.toBe(fp(song, 'verse1'));
    const up = structuredClone(song);
    for (const bar of up.arrangement['verse1']!.overrides!['Vocal']!.bars!) for (const evs of Object.values(bar.notes ?? {})) for (const e of evs as { note: number }[]) e.note += 2;
    expect(fp(up, 'verse1')).not.toBe(fp(song, 'verse1'));
    // The take is as long as its section: a longer section with the same notes is another take.
    const score = sectionScore(song, 'verse1')!;
    expect(takeFingerprint({ ...score, lengthSec: score.lengthSec + 2 }, 'en_prompt', 1)).not.toBe(takeFingerprint(score, 'en_prompt', 1));
  });
});

import { registerShift, trackMedian } from '../src/vocals/score.js';

describe('register: whole octaves to the voice', () => {
  it('moves a track by the octave that puts its median nearest the voice median (no move on a tie)', () => {
    expect(registerShift(63, 65)).toBe(0); // a lead line for a female voice: as written
    expect(registerShift(63, 53)).toBe(-12); // for a male voice: an octave down
    expect(registerShift(56, 65)).toBe(12); // a low backing line for a female voice: an octave up
    expect(registerShift(59, 65)).toBe(0); // 6 below vs 6 above: a tie stays as written
  });

  it('the track median is over all its notes in the song', () => {
    const song = golden();
    const lead = trackMedian(song, 'Vocal')!;
    const low = trackMedian(song, 'Backing vocals 2')!;
    expect(lead).toBeGreaterThan(low);
    expect(trackMedian(song, 'No such track')).toBeUndefined();
  });
});
