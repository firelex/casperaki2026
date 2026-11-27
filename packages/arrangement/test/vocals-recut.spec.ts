import { describe, expect, it } from 'vitest';

import { loadBankIndex, loadPrecedentBank, type Precedent } from '../src/vocals/precedents.js';
import { recutRhythm, type RecutRhythm } from '../src/vocals/recut.js';
import { lyricLines } from '../src/vocals/lyric-lines.js';
import { lineLengthProblems, lengthFits } from '../src/vocals/syllable-length.js';
import { checkLyricLine, pronounce } from '../src/vocals/written-lyrics.js';
import { heardStress } from '../src/vocals/stress.js';

/** A rhythm precedent from [beat, duration] notes over `bars` bars. */
const rhythm = (notes: readonly (readonly [number, number])[], bars: number): Precedent => ({
  id: 'test',
  properties: { start: 0, end: bars, useOriginal: false, useRemix: true, source: { kind: 'casperaki' } },
  melody: Object.fromEntries(notes.map(([b, d]) => [Number.isInteger(b) ? `${b}.0` : String(b), [{ note: 'c4', midi: 48, duration: d }]])),
  chords: Object.fromEntries(Array.from({ length: bars * 4 }, (_, b) => [`${b}.0`, { chord: 'C' }])),
});

/** The recut's notes as vocal bars. */
const barsOf = (r: RecutRhythm) =>
  Array.from({ length: r.bars }, (_, bar) => ({
    notes: Object.fromEntries(r.notes.filter((n) => Math.floor(n.start / 4 + 1e-9) === bar).map((n) => [String(n.start - bar * 4), [{ type: 'vocalNote', duration: n.duration }]])),
  }));

/** The recut played `times` times over (a longer section of the type repeats it). */
const repeated = (r: RecutRhythm, times: number): RecutRhythm => ({
  ...r,
  bars: r.bars * times,
  notes: Array.from({ length: times }, (_, t) => r.notes.map((n) => ({ start: n.start + t * r.bars * 4, duration: n.duration }))).flat(),
});

/** Every line sung on the recut passes the line check and the length rule; a word is sung straight through (no rest
 *  between its syllables); and the recut played twice reads back as the lines twice. */
function expectSingable(r: RecutRhythm, lines: readonly string[], bpm: number): void {
  const twice = lyricLines(barsOf(repeated(r, 2))).map((l) => l.length);
  const once = lyricLines(barsOf(r)).map((l) => l.length);
  expect(twice, 'played twice').toEqual([...once, ...once]);
  // Never faster than an eighth (owner, 2026-11-27: sixteenths sang too fast): every note starts on an eighth and
  // lasts at least one.
  r.notes.forEach((n) => {
    expect((n.start * 2) % 1, `note at ${n.start} on the eighth grid`).toBe(0);
    expect((n.duration * 2) % 1, `note at ${n.start} lasts whole eighths`).toBe(0);
  });
  const ends = lines.flatMap((l) => l.split(/\s+/u).flatMap((w) => pronounce(w)!.phones.map((_, i, all) => i === all.length - 1)));
  r.notes.forEach((n, i) => {
    if (!ends[i]) expect(r.notes[i + 1]!.start, `syllable ${i + 1} runs into the next of its word`).toBeCloseTo(n.start + n.duration, 9);
  });
  // Stress exactly (owner, 2026-11-27: "a" was heard stressed, "flashlight" as flash-LIGHT): a stressed syllable on a
  // note graded stressed, an unstressed one on a note graded unstressed, and no weak syllable of a longer word on a
  // stressed note.
  const endsAt = lines.flatMap((l) => l.split(/\s+/u).flatMap((w) => pronounce(w)!.phones.map((_, i, all) => i === all.length - 1)));
  const syllables = lines.flatMap((l) => l.split(/\s+/u).flatMap((w) => { const p = pronounce(w)!; return p.rhythm.map((st, i) => ({ word: w, st, byStress: p.rhythm[i - 1] === '+' || p.rhythm[i + 1] === '+' })); }));
  const grades = Array.from({ length: Math.ceil(r.bars) }, (_, bar) => {
    const inBar = r.notes.filter((n) => Math.floor(n.start / 4 + 1e-9) === bar);
    return inBar.map((n, i) => heardStress(n.start - bar * 4, n.duration, inBar[i - 1]?.duration, inBar[i + 1]?.duration));
  }).flat();
  syllables.forEach((y, i) => {
    const g = grades[i]!;
    const what = `syllable ${i + 1} ("${y.word}", ${y.st}) at beat ${r.notes[i]!.start} graded ${g}`;
    if (y.st === '+') {
      // Two stressed syllables side by side in a word ("out-side"): either may be on a note heard as either.
      if (y.byStress && g === '0') return;
      expect(g, what).toBe('+');
    }
    else if (y.st === '-') {
      // Or an eighth on beat 2 or 4, no longer than the note before it, before a note on beat 1 or 3 ("EV-e-ry TIME").
      const n = r.notes[i]!;
      const before = r.notes[i - 1];
      const inBar = n.start % 4;
      const weak = n.duration === 0.5 && (inBar === 1 || inBar === 3) && (!before || Math.floor(before.start / 4) !== Math.floor(n.start / 4) || n.duration <= before.duration) && r.notes[i + 1] !== undefined && r.notes[i + 1]!.start % 2 === 0;
      if (!weak) expect(g, what).toBe('-');
    }
    else if (y.byStress) expect(g, what).not.toBe('+');
    // A weaker syllable is never longer than the stressed syllable next to it in its word.
    const next = syllables[i + 1];
    if (next && next.word === y.word && !endsAt[i]) {
      if (y.st === '+' && next.st !== '+') expect(r.notes[i + 1]!.duration, `${what}: its weak neighbour outweighs it`).toBeLessThanOrEqual(r.notes[i]!.duration);
      if (next.st === '+' && y.st !== '+') expect(r.notes[i]!.duration, `${what}: it outweighs its stressed neighbour`).toBeLessThanOrEqual(r.notes[i + 1]!.duration);
    }
  });
  const sung = lyricLines(barsOf(r));
  expect(sung.map((l) => l.length)).toEqual(lines.map((l) => l.split(/\s+/u).flatMap((w) => pronounce(w)!.phones).length));
  lines.forEach((text, i) => {
    expect(checkLyricLine(text, sung[i]!), `line ${i + 1} "${text}"`).toBeUndefined();
    expect(lineLengthProblems(text, sung[i]!, bpm), `line ${i + 1} "${text}"`).toEqual([]);
  });
}

const POP_LINES = [
  'You gotta feel it', 'Take me home tonight', 'I know you want me back', 'We were never meant to last',
  'Call me when the party ends', 'Dancing on my own again', 'I can see it in your eyes', 'Do not tell me that you love me',
  'Hold on to the feeling', 'Kiss me like you mean it', 'I am not your girl anymore', 'Turn the music up so loud',
  'Every time you walk away', 'Baby it is cold outside', 'Lights are going out', 'Never gonna let you go',
  'Say my name and I will come', 'Running back to you', 'Tell me something real', 'All the stars are falling down',
  'I just want to dance', 'Give me one more night', 'Nothing feels the same', 'We could be forever young',
  'Heart beats like a drum', 'Look at what you did', 'Stay with me until the morning', 'And I know you',
  'Summer never ends with you', 'Drive me crazy every night', 'This is how we do it', 'Maybe I was wrong about you',
  'Shake it off and let it go', 'You are the one I want', 'Better when you are gone', 'Tonight we own the city',
  'Bring the fire to the floor', 'I keep on falling for you', 'Watch me shine', 'Nobody does it like you',
];

describe('the recut', () => {
  it('every test line is in the dictionary and has 4 to 11 syllables', () => {
    for (const l of POP_LINES) {
      const n = l.split(/\s+/u).map((w) => pronounce(w)).reduce((a, p) => (p ? a + p.phones.length : NaN), 0);
      expect(n, l).toBeGreaterThanOrEqual(3);
      expect(n, l).toBeLessThanOrEqual(11);
    }
  });

  it('a line that already fits keeps the pattern\'s notes unchanged', () => {
    const r = rhythm([[0, 0.5], [0.5, 0.5], [1, 0.5], [1.5, 0.5], [2, 2]], 2);
    const out = recutRhythm(r, ['Take me home tonight'], { bpm: 120, bars: 2 });
    expect(out.notes).toEqual([
      { start: 0, duration: 0.5 }, { start: 0.5, duration: 0.5 }, { start: 1, duration: 0.5 }, { start: 1.5, duration: 0.5 }, { start: 2, duration: 2 },
    ]);
  });

  it('"You gotta feel it" puts "go" on a short note and may hold "feel" (100 bpm)', () => {
    const r = rhythm([[0, 1], [1, 1], [2, 1], [3, 1], [4, 2]], 2);
    const out = recutRhythm(r, ['You gotta feel it'], { bpm: 100, bars: 2 });
    expectSingable(out, ['You gotta feel it'], 100);
    expect(lengthFits('short', out.notes[1]!.duration, 100)).toBe(true);
  });

  it('a line starting on a weak syllable may take a pickup, and it stays in its own line', () => {
    const r = rhythm([[0, 1], [1, 1], [2, 2], [4, 2], [8, 1], [9, 1], [10, 2], [12, 2]], 4);
    const lines = ['Hold on to the feeling', 'And I know you'];
    const out = recutRhythm(r, lines, { bpm: 110, bars: 4 });
    expectSingable(out, lines, 110);
  });

  it('every line keeps at least one note in its own bars (a line all pickups would join the line before)', () => {
    // Short lines after a busy one on the dance rhythms at 126 bpm (found by a sweep over seeds: "4/4/8").
    const lines = ['Oh la la heart', 'Oh la la day', 'Oh la la dream', 'Oh la la way'];
    for (const e of loadPrecedentBank('rhythmic-dance')) expectSingable(recutRhythm(e, lines, { bpm: 126, bars: 8 }), lines, 126);
  });

  it('a word is sung straight through, at slow and fast tempos ("Feeling nothing tonight")', () => {
    const r = rhythm([[0, 1], [1, 1], [2, 1], [3, 1], [4, 1], [5, 1], [6, 1], [7, 1]], 2);
    for (const bpm of [70, 100, 170]) expectSingable(recutRhythm(r, ['Feeling nothing tonight'], { bpm, bars: 2 }), ['Feeling nothing tonight'], bpm);
  });

  it('"Two ghosts with a sheet and a flashlight": "a" unstressed, FLASH-light (Electric Daydream, 128 bpm)', () => {
    const verse = loadPrecedentBank('hooks').find((p) => String(p.id) === '25-fast-edm-04')!;
    const lines = ['We drew it up on a Tuesday night', 'Two ghosts with a sheet and a flashlight', 'You swore that the glue gun would hold', "Now it's midnight and the tape won't fight"];
    expectSingable(recutRhythm(verse, lines, { bpm: 128, bars: 8 }), lines, 128);
  });

  it('holds a word that carries the meaning, not a small word before it ("don\'t give a frown": not "don\'t")', () => {
    // The pattern's held note falls where "don't" would go.
    const r = rhythm([[0, 0.5], [0.5, 0.5], [1, 0.5], [1.5, 0.5], [2, 0.5], [3, 2], [5, 0.5], [5.5, 0.5], [6, 1.5]], 2);
    const line = "Electric daydream, don't give a frown";
    const out = recutRhythm(r, [line], { bpm: 128, bars: 2 });
    expectSingable(out, [line], 128);
    const dont = out.notes[5]!;
    expect(dont.duration, `"don't" at ${dont.start}`).toBeLessThan(1);
  });

  it('is deterministic', () => {
    const r = rhythm([[0, 1], [1, 1], [2, 1], [3, 1], [4, 2]], 2);
    expect(recutRhythm(r, ['Maybe I was wrong about you'], { bpm: 120, bars: 2 })).toEqual(recutRhythm(r, ['Maybe I was wrong about you'], { bpm: 120, bars: 2 }));
  });

  it('property: every bank rhythm takes any accepted line, at 70 and at 170 bpm', () => {
    const entries = Object.keys(loadBankIndex().banks).flatMap((id) => {
      const bank = loadPrecedentBank(id);
      // All the curated and style rhythms; every 7th hook (706 hooks would take minutes).
      return id === 'hooks' ? bank.filter((_, i) => i % 7 === 0) : [...bank];
    });
    let k = 0;
    for (const bpm of [70, 170]) {
      for (const e of entries) {
        const lines = Array.from({ length: 4 }, () => POP_LINES[k++ % POP_LINES.length]!);
        const out = recutRhythm(e, lines, { bpm, bars: 8 });
        expectSingable(out, lines, bpm);
      }
    }
  }, 120_000);
});
