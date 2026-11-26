// Written lyrics (docs/superpowers/specs/2026-11-24-written-lyrics-design.md): lyric lines of a melody, the checks
// the lyricist's lines must pass, attaching them (held and split notes), recording them in the generator block, and
// the vocal edits (new words, new melody) applied throughout the song.

import { describe, expect, it } from 'vitest';

import type { Song } from '@casperaki/song-schema';

import {
  applyWrittenLyrics,
  checkSectionLyrics,
  gradeNote,
  HELD_SYLLABLE,
  lyricLines,
  lyricsTargets,
  newMelody,
  orchestrate,
  paramsWithLyrics,
  rhymeScheme,
  sungSections,
  vocalMelodyShown,
  writeMelody,
  wordsRhyme,
  type LyricLine,
  type WrittenLyrics,
} from '../src/index.js';
import { attachWrittenLyrics } from '../src/vocals/written-lyrics.js';
import type { VocalSegment } from '../src/vocals/types.js';

const PARAMS = { genre: 'brightPop', key: 'C', bpm: 110, seed: 'a' } as const;

/** Lines that fit exactly: "la" on every note but the last, which rhymes with its partner line. */
function fittingLines(lines: readonly LyricLine[]): string[] {
  const families = [['day', 'way', 'say'], ['night', 'light', 'bright'], ['rain', 'pain', 'chain'], ['sea', 'free', 'tree']];
  const scheme = rhymeScheme(lines.length);
  const used = new Map<string, number>();
  return lines.map((l, i) => {
    const letter = scheme[i]!;
    const fam = families[(letter.charCodeAt(0) - 65) % families.length]!;
    const k = used.get(letter) ?? 0;
    used.set(letter, k + 1);
    return [...Array.from({ length: l.length - 1 }, () => 'la'), fam[k]!].join(' ');
  });
}

function lyricsFor(song: Song, filter: (type: string) => boolean = () => true): WrittenLyrics {
  return Object.fromEntries(sungSections(song).filter((s) => filter(s.type)).map((s) => [s.name, fittingLines(s.lines)]));
}

/** A lyric line from [bar, beat, duration] notes, each graded by the old rules with its neighbours in its bar. */
function lineOf(notes: readonly (readonly [number, number, number])[]): LyricLine {
  return notes.map(([barIndex, beat, duration]) => {
    const inBar = notes.filter(([b]) => b === barIndex);
    const j = inBar.findIndex(([, b]) => b === beat);
    const prevInBar = inBar[j - 1]?.[2];
    const nextInBar = inBar[j + 1]?.[2];
    return { barIndex, beat, duration, start: barIndex * 4 + beat, grade: gradeNote(beat, duration, prevInBar, nextInBar), prevInBar, nextInBar };
  });
}

describe('lyric lines', () => {
  it('cuts a melody every two bars, keeps every note, never a line over 16 notes', () => {
    const song = orchestrate(PARAMS);
    for (const s of sungSections(song)) {
      for (const line of s.lines) expect(line.length).toBeGreaterThanOrEqual(1);
      for (const line of s.lines) expect(line.length).toBeLessThanOrEqual(16);
      expect(s.lines.flat().length).toBe(Object.values(song.arrangement[s.name]!.overrides.Vocal!.bars!).flatMap((b) => Object.values(b.notes ?? {}).flat()).length);
    }
  });

  /** Bars from [bar, beat, duration] vocal notes (bars from 0). */
  const barsOf = (n: number, notes: [number, number, number][]) =>
    Array.from({ length: n }, (_, bi) => ({
      notes: Object.fromEntries(notes.filter(([b]) => b === bi).map(([, beat, duration]) => [beat.toFixed(1), [{ type: 'vocalNote', note: 60, duration }]])),
    }));
  const starts = (bars: ReturnType<typeof barsOf>) => lyricLines(bars).map((l) => l.map((x) => x.start));

  it('a line is two bars; a note sung in a line\'s bars before a rest belongs to that line (Tangerine "…behind we")', () => {
    // Tangerine Sidewalk verse 1: "Leaving chill behind" in bars 5-6, "We" at bar 6 beat 1.5 then a beat of rest,
    // "Walk slow and warm our bones" from bar 7.
    const bars = barsOf(8, [
      [4, 0, 1], [4, 1, 0.5], [4, 1.5, 1], [4, 2.5, 1], [4, 3.5, 2], [5, 1.5, 1.5],
      [6, 0, 1], [6, 1, 0.5], [6, 1.5, 1], [6, 2.5, 1], [6, 3.5, 0.5], [7, 0, 1],
    ]);
    expect(starts(bars)).toEqual([[16, 17, 17.5, 18.5, 19.5, 21.5], [24, 25, 25.5, 26.5, 27.5, 28]]);
  });

  it('a pickup (short notes at the end of a line running straight into the next) opens the next line', () => {
    // "…brick walls" in bars 1-2, "Cit-" at bar 2 beat 3.5 running into "rus" on bar 3's first beat.
    const bars = barsOf(4, [[0, 0, 1], [0, 1, 0.5], [0, 1.5, 1], [0, 2.5, 1], [0, 3.5, 1], [1, 0.5, 1.5], [1, 3.5, 0.5], [2, 0, 1], [2, 1, 0.5], [2, 1.5, 1]]);
    expect(starts(bars)).toEqual([[0, 1, 1.5, 2.5, 3.5, 4.5], [7.5, 8, 9, 9.5]]);
  });

  it('a held note ending a phrase into the next line is not a pickup; a short last line stays a line', () => {
    // Tangerine bridge: "Light Sun-light" with "light" held two beats up to bar 5; "Grows Bright" alone in bars 7-8.
    const bars = barsOf(8, [[0, 0, 4], [1, 1, 1], [1, 2, 2], [2, 0, 4], [3, 1, 1], [3, 2, 2], [4, 0, 3], [4, 3, 1], [5, 1, 1], [5, 2, 2], [6, 0, 2], [6, 2, 5]]);
    expect(starts(bars)).toEqual([[0, 5, 6], [8, 13, 14], [16, 19, 21, 22], [24, 26]]);
  });

  it('rhymes lines ABCB in fours (a leftover three ABA, a leftover two AA, a leftover one free)', () => {
    expect(rhymeScheme(4)).toEqual(['A', 'B', 'C', 'B']);
    expect(rhymeScheme(8)).toEqual(['A', 'B', 'C', 'B', 'D', 'E', 'F', 'E']);
    expect(rhymeScheme(3)).toEqual(['A', 'B', 'A']);
    expect(rhymeScheme(6)).toEqual(['A', 'B', 'C', 'B', 'D', 'D']);
    expect(rhymeScheme(5)).toEqual(['A', 'B', 'C', 'B', 'D']);
    expect(rhymeScheme(1)).toEqual(['A']);
  });
});

describe('checking lines', () => {
  const four = lineOf([[0, 0, 1], [0, 1, 1], [0, 2, 1], [0, 3, 1]]);

  it('accepts lines that fit and rhyme', () => {
    expect(checkSectionLyrics([four, four], ['walk into the night', 'all the city light'])).toEqual([]);
  });

  it('names the syllable count, the dictionary split and the fix', () => {
    // Half-beat notes: too short to split for an extra syllable.
    const short = lineOf([[0, 0, 0.5], [0, 0.5, 0.5], [0, 1, 0.5], [0, 1.5, 0.5]]);
    const [p] = checkSectionLyrics([short], ['sunlight on my street']);
    expect(p!.message).toMatch(/has 5 syllables \(sun·light on my street\) but must have exactly 4: remove 1 syllable/u);
  });

  it('asks for other words when one is not in the dictionary', () => {
    const [p] = checkSectionLyrics([four], ['la la la zxqvy']);
    expect(p!.message).toMatch(/zxqvy/u);
  });

  it('wants rhyming last words, never the same word twice', () => {
    expect(checkSectionLyrics([four, four], ['walk into the night', 'all the city lane'])[0]!.message).toMatch(/must rhyme/u);
    expect(checkSectionLyrics([four, four], ['walk into the night', 'all into the night'])[0]!.message).toMatch(/same word, "night": a word may not rhyme with itself/u);
  });

  it('checks ABCB: only line 4 has to rhyme with line 2', () => {
    const lines = [four, four, four, four];
    expect(checkSectionLyrics(lines, ['walk into the rain', 'all the city light', 'la la la day', 'la la la night'])).toEqual([]);
    const [p] = checkSectionLyrics(lines, ['walk into the rain', 'all the city light', 'la la la day', 'la la la rain']);
    expect(p!.line).toBe(3);
    expect(p!.message).toMatch(/Lines 2 and 4 must rhyme/u);
  });

  it('hears pop rhymes: the same vowel sound from the last stressed one on', () => {
    for (const [a, b] of [['time', 'mind'], ['fire', 'higher'], ['now', 'out'], ['near', 'here'], ['gone', 'on'], ['heart', 'apart']]) expect(wordsRhyme(a!, b!)).toBe(true);
    for (const [a, b] of [['day', 'night'], ['you', 'you'], ['flood', 'stood']]) expect(wordsRhyme(a!, b!)).toBe(false);
  });

  it('takes sung short forms ("ev-ry") and lets a line be a little short or long', () => {
    // "every day" is 4 syllables in the dictionary, 3 sung as "ev-ry day".
    const three = lineOf([[0, 0, 1], [0, 1, 1], [0, 2, 2]]);
    expect(checkSectionLyrics([three], ['every day'])).toEqual([]);
    // 8 legato notes: 6 syllables (2 held notes) or 10 (2 split notes) fit, 5 and 11 do not.
    const eight = lineOf(Array.from({ length: 8 }, (_, i) => [Math.floor(i / 4), i % 4, 1] as const));
    expect(checkSectionLyrics([eight], ['la la la la la day'])).toEqual([]);
    expect(checkSectionLyrics([eight], ['la la la la la la la la la day'])).toEqual([]);
    expect(checkSectionLyrics([eight], ['la la la la day'])[0]!.message).toMatch(/add 3 syllables/u);
    expect(checkSectionLyrics([eight], ['la la la la la la la la la la day'])[0]!.message).toMatch(/remove 3 syllables/u);
  });

  it('sends back a line with any word sung against its stress', () => {
    // Eighths from beat 1.5 graded - + - + - +: "tonight" fits (to-NIGHT), "happy" (HAP-py) does not.
    const six = lineOf([[0, 0.5, 0.5], [0, 1, 0.5], [0, 1.5, 0.5], [0, 2, 0.5], [0, 2.5, 0.5], [0, 3, 0.5]]);
    expect(checkSectionLyrics([six], ['tonight tonight tonight'])).toEqual([]);
    expect(checkSectionLyrics([six], ['happy happy happy'])[0]!.message).toMatch(/Sung against the stress: "hap·py": its stressed syllable "hap" falls on a weak note; "hap·py": its unstressed syllable "py" falls on a strong note/u);
  });

  it('counts small unstressed words too: "the" on a strong note is a clash, on a weak one fine', () => {
    // Quarters on every beat: + - + - (beats 1 and 3 strong).
    expect(checkSectionLyrics([four], ['walk the night home'])).toEqual([]);
    expect(checkSectionLyrics([four], ['the sun is bright'])[0]!.message).toMatch(/"the" is a small unstressed word but falls on a strong note/u);
    // Every clash of the line is named, not only the first.
    expect(checkSectionLyrics([four], ['the sun and night'])[0]!.message).toMatch(/"the" is a small unstressed word but falls on a strong note; "and" is a small unstressed word but falls on a strong note/u);
  });

  it('sends back a line that cuts a word across a held note (a half note or longer)', () => {
    // DA DA DA(held, 2 beats) DA: the held note must carry the end of a word.
    const line = lineOf([[0, 0, 1], [0, 1, 1], [0, 2, 2], [1, 0, 1]]);
    expect(checkSectionLyrics([line], ['walk the night home'])).toEqual([]);
    const [p] = checkSectionLyrics([line], ['in the sunrise']);
    expect(p!.message).toMatch(/cut in two across a long held note/u);
    expect(p!.message).toMatch(/"sun·rise" \(held on "sun"\)/u);
    // A held note carrying a syllable over a spare note still ends the word when that syllable does.
    const slur = lineOf([[0, 0, 1], [0, 1, 1], [0, 2, 2], [1, 0, 1], [1, 1, 1]]);
    expect(checkSectionLyrics([slur], ['walk the night home'])).toEqual([]);
  });
});

describe('attaching lines to notes', () => {
  const segment = (durations: readonly number[]): VocalSegment => {
    const notes: Record<string, unknown[]> = {};
    let beat = 0;
    for (const d of durations) {
      notes[beat.toFixed(1)] = [{ type: 'vocalNote', note: 60, duration: d }];
      beat += d;
    }
    return { segmentName: 'verse1', bars: [{ notes }] } as unknown as VocalSegment;
  };
  const sung = (seg: VocalSegment) =>
    Object.entries(seg.bars[0]!.notes)
      .sort(([a], [b]) => Number(a) - Number(b))
      .flatMap(([beat, evs]) => evs.map((e) => `${beat}:${e.duration}:${e.fullWord}`));

  it('sings one syllable per note, the word split into syllables', () => {
    expect(sung(attachWrittenLyrics(segment([1, 1, 1, 1]), ['I see tonight']))).toEqual(['0.0:1:I', '1.0:1:See', '2.0:1:To-', '3.0:1:night']);
  });

  it('writes the word over its notes split the owner\'s way, sung contractions spelled short', () => {
    expect(sung(attachWrittenLyrics(segment([1, 1, 1, 1]), ['control rhythm']))).toEqual(['0.0:1:Con-', '1.0:1:trol', '2.0:1:Rhy-', '3.0:1:thm']);
    // "every" on two notes is sung "ev'ry": the dropped vowel letter goes.
    expect(sung(attachWrittenLyrics(segment([1, 1, 2]), ['every day']))).toEqual(['0.0:1:E-', '1.0:1:vry', '2.0:2:Day']);
  });

  it('holds a syllable over a spare note', () => {
    const out = attachWrittenLyrics(segment([0.5, 0.5, 0.5, 0.5, 1, 1]), ['oh my love so true']);
    expect(sung(out).filter((s) => s.endsWith(`:${HELD_SYLLABLE}`))).toHaveLength(1);
  });

  it('splits a long note in two for an extra syllable, the one that keeps every word on its stress', () => {
    // Splitting the half note (the longest, tried first) would put "to" on beat 3, a strong note; splitting the
    // quarter on beat 2 puts it on an off-beat eighth (weak) and "night" on the half note (free).
    expect(sung(attachWrittenLyrics(segment([1, 1, 2]), ['I see tonight']))).toEqual(['0.0:1:I', '1.0:0.5:See', '1.5:0.5:To-', '2.0:2:night']);
  });
});

describe('written lyrics in the generator block', () => {
  it('replays the song with the recorded words on the lead and the backings', () => {
    const draft = orchestrate(PARAMS);
    const lyrics = lyricsFor(draft);
    const params = paramsWithLyrics(PARAMS, lyrics);
    const song = orchestrate(params);
    expect(orchestrate(params)).toEqual(song);
    for (const s of sungSections(song)) expect(s.words.map((w) => w.toLowerCase())).toEqual(lyrics[s.name]);
    const backing = Object.values(song.arrangement).flatMap((a) => (a.overrides['Backing vocals 1']?.bars ?? []).flatMap((b) => Object.values(b.notes ?? {}).flat()));
    expect(backing.length).toBeGreaterThan(0);
    for (const e of backing) expect((e as { fullWord?: string }).fullWord).toMatch(/^(La|Day|Way|Say|Night|Light|Bright|Rain|Pain|Chain|Sea|Free|Tree|-)$/u);
  });

  it('refuses recorded words that no longer fit the melody', () => {
    const draft = orchestrate(PARAMS);
    const [first] = sungSections(draft);
    expect(() => orchestrate(paramsWithLyrics(PARAMS, { [first!.name]: first!.lines.map(() => 'la') }))).toThrow(/does not fit|syllables/u);
  });
});

describe('vocal edits', () => {
  const song = orchestrate(paramsWithLyrics(PARAMS, lyricsFor(orchestrate(PARAMS))));

  it('new words for one section type change every section of it and nothing else', () => {
    const { generated, sections } = lyricsTargets(song, 'chorus2');
    expect(sections.every((n) => n.startsWith('chorus'))).toBe(true);
    const words: WrittenLyrics = Object.fromEntries(
      sungSections(generated)
        .filter((s) => sections.includes(s.name))
        .map((s) => [s.name, s.lines.map((l, i) => [...Array.from({ length: l.length - 1 }, () => 'oh'), ['day', 'way'][i % 2]].join(' '))]),
    );
    const edited = applyWrittenLyrics(song, words);
    for (const s of sungSections(edited)) {
      if (s.type === 'chorus') expect(s.words.join(' ')).toMatch(/^Oh/u);
      else expect(s.words).toEqual(sungSections(song).find((o) => o.name === s.name)!.words);
    }
  });

  it('a new melody changes every section of its type (notes and chords), and keeps the others', () => {
    const made = newMelody(song, 'chorus');
    const before = (s: Song, name: string) => JSON.stringify(s.arrangement[name]!.overrides.Vocal?.bars);
    expect(made.sections.every((n) => n.startsWith('chorus'))).toBe(true);
    for (const seg of song.songStructure) {
      const changed = before(made.song, seg.name) !== before(song, seg.name);
      if (seg.name.startsWith('chorus')) expect(changed).toBe(true);
      else if (song.arrangement[seg.name]!.overrides.Vocal) expect(changed).toBe(false);
    }
    const choruses = made.song.songStructure.filter((s) => s.name.startsWith('chorus'));
    expect(new Set(choruses.map((c) => JSON.stringify(c.bars.map((b) => b.chords)))).size).toBe(1);
    // Words for the new chorus melody, recorded and replayed.
    const withWords = applyWrittenLyrics(made.song, lyricsFor(made.generated, (t) => t === 'chorus'));
    const g = withWords.generator!.params as { params: { melodyVariants: Record<string, number>; lyrics: WrittenLyrics } };
    expect(g.params.melodyVariants).toEqual({ chorus: expect.any(Number) });
    expect(Object.keys(g.params.lyrics).sort()).toEqual(sungSections(made.generated).map((s) => s.name).sort());
  });
});

describe('a hidden vocal melody (new songs) and Write melody', () => {
  const VOCALS = ['Vocal', 'Backing vocals 1', 'Backing vocals 2'];
  const shown = orchestrate(PARAMS);
  const hidden = orchestrate({ ...PARAMS, params: { vocalMelody: false } });
  const vocalsOf = (song: Song) => Object.fromEntries(song.songStructure.map((s) => [s.name, VOCALS.map((t) => [song.arrangement[s.name]!.instruments[t], song.arrangement[s.name]!.overrides[t]])]));
  const withoutVocals = (song: Song) => ({
    defs: song.instrumentDefinitions,
    structure: song.songStructure,
    arrangement: Object.fromEntries(
      Object.entries(song.arrangement).map(([n, a]) => [n, { ...a, instruments: Object.fromEntries(Object.entries(a.instruments).filter(([t]) => !VOCALS.includes(t))), overrides: Object.fromEntries(Object.entries(a.overrides).filter(([t]) => !VOCALS.includes(t))) }]),
    ),
  });

  it('keeps the vocal tracks defined but empty, and changes nothing else', () => {
    expect(vocalMelodyShown(hidden)).toBe(false);
    expect(vocalMelodyShown(shown)).toBe(true);
    for (const t of VOCALS) expect(hidden.instrumentDefinitions.some((d) => d.name === t)).toBe(true);
    for (const a of Object.values(hidden.arrangement)) {
      for (const t of VOCALS) {
        expect(a.instruments[t]).toBe(false);
        expect(a.overrides[t]).toBeUndefined();
      }
    }
    expect(sungSections(hidden)).toEqual([]);
    expect(withoutVocals(hidden)).toEqual(withoutVocals(shown));
  });

  it('Write melody shows the melody the generator chose, in every section', () => {
    const written = writeMelody(hidden);
    expect(vocalMelodyShown(written)).toBe(true);
    expect(vocalsOf(written)).toEqual(vocalsOf(shown));
    expect(() => writeMelody(written)).toThrow(/has a vocal melody already/u);
  });

  it('writing lyrics on a hidden melody shows it with the words', () => {
    const lyrics = lyricsFor(shown);
    const song = applyWrittenLyrics(hidden, lyrics);
    expect(vocalMelodyShown(song)).toBe(true);
    for (const s of sungSections(song)) expect(s.words.map((w) => w.toLowerCase())).toEqual(lyrics[s.name]);
  });
});
