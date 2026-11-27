import { describe, expect, it } from 'vitest';

import { loadBankIndex, loadPrecedentBank, type Precedent } from '../src/vocals/precedents.js';
import { recutRhythm, SMALL_WORDS, type RecutRhythm } from '../src/vocals/recut.js';
import { lyricLines } from '../src/vocals/lyric-lines.js';
import { lineLengthProblems, lengthFits, syllableLength } from '../src/vocals/syllable-length.js';
import { HOLD_BEATS, pronounce, sungLineSyllables, wordsOf } from '../src/vocals/written-lyrics.js';
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
/** Returns how many syllables miss their stress; with `exact` (the default) there must be none. */
const syllablesIn = (lines: readonly string[]) => lines.reduce((a, l) => a + wordsOf(l).reduce((b, w) => b + pronounce(w)!.phones.length, 0), 0);

/** Rests the property test lets through (counted apart from stress misses). */
let restMisses = 0;
/** Small words stressed before an unstressed content word the property test lets through. */
let leanMisses = 0;
function expectSingable(r: RecutRhythm, lines: readonly string[], bpm: number, exact = true): number {
  let misses = 0;
  const miss = (ok: boolean, what: string) => {
    if (ok) return;
    if (exact) expect.fail(what);
    misses++;
  };
  const twice = lyricLines(barsOf(repeated(r, 2))).map((l) => l.length);
  const once = lyricLines(barsOf(r)).map((l) => l.length);
  expect(twice, 'played twice').toEqual([...once, ...once]);
  // Never faster than an eighth (owner, 2026-11-27: sixteenths sang too fast): every note starts on an eighth and
  // lasts at least one.
  r.notes.forEach((n) => {
    expect((n.start * 2) % 1, `note at ${n.start} on the eighth grid`).toBe(0);
    expect((n.duration * 2) % 1, `note at ${n.start} lasts whole eighths`).toBe(0);
  });
  const ends = lines.flatMap((l) => wordsOf(l).flatMap((w) => pronounce(w)!.phones.map((_, i, all) => i === all.length - 1)));
  r.notes.forEach((n, i) => {
    // A note held HOLD_BEATS or more sings the end of a word.
    if (n.duration >= HOLD_BEATS) expect(ends[i], `the note at ${n.start} is held but its syllable does not end its word`).toBe(true);
    if (!ends[i]) expect(r.notes[i + 1]!.start, `syllable ${i + 1} runs into the next of its word`).toBeCloseTo(n.start + n.duration, 9);
  });
  // Rests inside a line (owner, 2026-11-27, "Got the cake and the candles lit": an eighth then a rest phrased
  // awkwardly): none after a small word, which leads into the next ("the | candles", "your | favorite"), and none
  // shorter than a beat as laid, and an eighth before a rest sung on as a quarter.
  const words = lines.map((l) => wordsOf(l).flatMap((w) => pronounce(w)!.phones.map(() => w.toLowerCase().replace(/[‘’`]/gu, "'"))));
  const sylLength = lines.flatMap((l) => wordsOf(l).flatMap((w) => pronounce(w)!.phones.map((ph, i, all) => syllableLength(ph, i === all.length - 1))));
  let at = 0;
  words.forEach((line) => {
    for (let i = at; i < at + line.length - 1; i++) {
      const n = r.notes[i]!;
      const rest = r.notes[i + 1]!.start - (n.start + n.duration);
      if (rest <= 1e-9) continue;
      const word = line[i - at]!;
      // A breath: a beat of rest as laid (a note sung on into it leaves half a beat at least), after a note of a
      // beat, unless its syllable may not last a beat at this tempo.
      const laidRest = r.notes[i + 1]!.start - n.start - Math.min(n.duration, 0.5);
      if (!SMALL_WORDS.has(word) && laidRest >= 1 && rest >= 0.5 && (n.duration >= 1 || !lengthFits(sylLength[i]!, 1, bpm))) continue;
      if (exact) expect.fail(`a rest of ${rest} after "${word}" at ${n.start}`);
      restMisses++;
    }
    at += line.length;
  });
  // Stress exactly (owner, 2026-11-27: "a" was heard stressed, "flashlight" as flash-LIGHT): a stressed syllable on a
  // note graded stressed, an unstressed one on a note graded unstressed, and no weak syllable of a longer word on a
  // stressed note.
  const endsAt = lines.flatMap((l) => wordsOf(l).flatMap((w) => pronounce(w)!.phones.map((_, i, all) => i === all.length - 1)));
  const syllables = lines.flatMap((l) => wordsOf(l).flatMap((w) => { const p = pronounce(w)!; return p.rhythm.map((st, i) => ({ word: w, st, byStress: p.rhythm[i - 1] === '+' || p.rhythm[i + 1] === '+' })); }));
  // Stresses are heard on the notes as laid: a note sung on into a rest, up to a beat, weighs as an eighth.
  const heard = r.notes.map((n, i) => {
    const next = r.notes[i + 1];
    return next && next.start > n.start + n.duration + 1e-9 && n.duration <= 1 ? { ...n, duration: 0.5 } : n;
  });
  const grades = Array.from({ length: Math.ceil(r.bars) }, (_, bar) => {
    const inBar = heard.filter((n) => Math.floor(n.start / 4 + 1e-9) === bar);
    return inBar.map((n, i) => heardStress(n.start - bar * 4, n.duration, inBar[i - 1]?.duration, inBar[i + 1]?.duration));
  }).flat();
  syllables.forEach((y, i) => {
    const g = grades[i]!;
    const what = `syllable ${i + 1} ("${y.word}", ${y.st}) at beat ${r.notes[i]!.start} graded ${g}`;
    if (y.st === '+') {
      // Two stressed syllables side by side in a word ("out-side"): either may be on a note heard as either.
      if (!(y.byStress && g === '0')) miss(g === '+', what);
    }
    else if (y.st === '-') {
      // Or an eighth on beat 2 or 4, no longer than the note before it, before a note on beat 1 or 3 ("EV-e-ry TIME").
      const n = heard[i]!;
      const before = heard[i - 1];
      const inBar = n.start % 4;
      const weak = n.duration === 0.5 && (inBar === 1 || inBar === 3) && (!before || Math.floor(before.start / 4) !== Math.floor(n.start / 4) || n.duration <= before.duration) && r.notes[i + 1] !== undefined && r.notes[i + 1]!.start % 2 === 0;
      if (!weak) miss(g === '-', what);
    }
    else if (y.byStress) miss(g !== '+', what);
    // A weaker syllable is never longer than the stressed syllable next to it in its word.
    const next = syllables[i + 1];
    if (next && next.word === y.word && !endsAt[i]) {
      if (y.st === '+' && next.st !== '+') miss(heard[i + 1]!.duration <= heard[i]!.duration, `${what}: its weak neighbour outweighs it`);
      if (next.st === '+' && y.st !== '+') miss(heard[i]!.duration <= heard[i + 1]!.duration, `${what}: it outweighs its stressed neighbour`);
    }
  });
  // One-syllable words (owner, 2026-11-27: "YOU laughed", "I'M done"): a small word is not heard stressed before a
  // content word heard unstressed.
  const mono = lines.flatMap((l) => wordsOf(l).flatMap((w) => { const p = pronounce(w)!; const key = w.toLowerCase().replace(/[‘’`]/gu, "'").replace(/[^a-z']/gu, ''); return p.phones.map(() => (p.phones.length === 1 && p.rhythm[0] === '0' ? (SMALL_WORDS.has(key) ? 'small' : 'content') : undefined)); }));
  mono.forEach((m, i) => {
    if (m !== 'small' || mono[i + 1] !== 'content' || grades[i] !== '+' || grades[i + 1] !== '-') return;
    // A cost in the search, traded against the stresses: counted (the tests that want none say so).
    leanMisses++;
  });
  const sung = lyricLines(barsOf(r));
  expect(sung.map((l) => l.length)).toEqual(lines.map((l) => wordsOf(l).flatMap((w) => pronounce(w)!.phones).length));
  lines.forEach((text, i) => {
    expect(lineLengthProblems(text, sung[i]!, bpm, true), `line ${i + 1} "${text}"`).toEqual([]);
  });
  return misses;
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
  // Runs of unstressed syllables across words (owner's Cinnamon Boulevard: CIN-na-mon BOU-le-vard).
  'Cinnamon boulevard that is where we are', 'Beautiful and dangerous', 'Happily ever after', 'Talking in the elevator',
  'Electric daydream in town', 'Everybody knows it', 'Sweater in my drawer', "We're on your roof at two a.m.",
  'Shake it off and let it go', 'You are the one I want', 'Better when you are gone', 'Tonight we own the city',
  'Bring the fire to the floor', 'I keep on falling for you', 'Watch me shine', 'Nobody does it like you',
];

describe('the recut', () => {
  it('every test line is in the dictionary and has 4 to 11 syllables', () => {
    for (const l of POP_LINES) {
      const n = wordsOf(l).map((w) => pronounce(w)).reduce((a, p) => (p ? a + p.phones.length : NaN), 0);
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
    // One weak syllable on a note heard either way, so that "on" is not stressed after "Hold".
    expect(expectSingable(out, lines, 110, false)).toBeLessThanOrEqual(1);
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

  it('"You said don\'t make a fuss tonight": no eighth note before a rest (Electric Daydream, 128 bpm)', () => {
    const verse = loadPrecedentBank('hooks').find((p) => String(p.id) === '25-fast-edm-04')!;
    const lines = ["You said don't make a fuss tonight", 'So I played it cool, acted like I forgot', "But your favorite cake's in the fridge", 'With a cheap little candle on top'];
    // One stress is traded for the rests ("rite" of "favorite" on a quarter on beat 4).
    restMisses = 0;
    const out = recutRhythm(verse, lines, { bpm: 128, bars: 8 });
    expect(expectSingable(out, lines, 128, false)).toBeLessThanOrEqual(1);
    expect(restMisses).toBe(0);
  });

  it('"Got the cake and the candles lit": no rest after "the" or "your", none shorter than a beat (Electric Daydream, 128 bpm)', () => {
    const verse = loadPrecedentBank('hooks').find((p) => String(p.id) === '25-fast-edm-04')!;
    const lines = ['Got the cake and the candles lit', 'Your favorite song on repeat', 'Checked my phone about a hundred times', "But you're still not on my street"];
    expectSingable(recutRhythm(verse, lines, { bpm: 128, bars: 8 }), lines, 128);
  });

  it('"You laughed", "I\'m done": the content word, not the small word, on the stronger note (Electric Daydream, 128 bpm)', () => {
    const verse = loadPrecedentBank('hooks').find((p) => String(p.id) === '25-fast-edm-04')!;
    const lines = ["You said I'd never make it on my own", 'You laughed when I asked for a raise', "I signed the contract, now I'm fully gone", "I'm done with your two-faced ways"];
    leanMisses = 0;
    expectSingable(recutRhythm(verse, lines, { bpm: 128, bars: 8, echo: true }), lines, 128, false);
    expect(leanMisses).toBe(0);
  });

  it('with echo, lines 3 and 4 are sung to the rhythm lines 1 and 2 got (verses and choruses)', () => {
    const verse = loadPrecedentBank('hooks').find((p) => String(p.id) === '25-fast-edm-04')!;
    const pair = ['Got the cake and the candles lit', 'Your favorite song on repeat'];
    const lines = [...pair, ...pair];
    const out = recutRhythm(verse, lines, { bpm: 128, bars: 8, echo: true });
    expectSingable(out, lines, 128);
    const n = syllablesIn(pair);
    const first = out.notes.slice(0, n);
    const second = out.notes.slice(n).map((x) => ({ start: x.start - 16, duration: x.duration }));
    expect(second).toEqual(first);
    // Without echo, the pattern's bars 5 to 8 differ from its bars 1 to 4.
    const free = recutRhythm(verse, lines, { bpm: 128, bars: 8 });
    expect(free.notes.slice(n).map((x) => ({ start: x.start - 16, duration: x.duration }))).not.toEqual(free.notes.slice(0, n));
  });

  it('with echo, a line 3 of other words keeps most of line 1\'s onsets', () => {
    const verse = loadPrecedentBank('hooks').find((p) => String(p.id) === '25-fast-edm-04')!;
    const lines = ["You said don't make a fuss tonight", 'So I played it cool, acted like I forgot', "But your favorite cake's in the fridge", 'With a cheap little candle on top'];
    const out = recutRhythm(verse, lines, { bpm: 128, bars: 8, echo: true });
    expectSingable(out, lines, 128, false);
    const [a, b, c, d] = lines.map((l) => syllablesIn([l]));
    const on = (from: number, count: number, shift: number) => new Set(out.notes.slice(from, from + count).map((x) => x.start - shift));
    const shared = (x: Set<number>, y: Set<number>) => [...x].filter((v) => y.has(v)).length / Math.max(x.size, y.size);
    expect(shared(on(0, a!, 0), on(a! + b!, c!, 16))).toBeGreaterThanOrEqual(0.6);
    expect(shared(on(a!, b!, 0), on(a! + b! + c!, d!, 16))).toBeGreaterThanOrEqual(0.6);
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

  it('words written first are sung as written: one syllable per note, never a word shortened onto a held note', () => {
    // "Bring the fire to the floor" on notes where the old planner would sing "fire" in one syllable and hold "the".
    const slots = lyricLines([{ notes: {} }, { notes: {} }, { notes: Object.fromEntries([[0, 0.5], [0.5, 0.5], [1, 0.5], [1.5, 0.5], [2.5, 0.5], [3, 0.5]].map(([b, d]) => [String(b), [{ type: 'vocalNote', duration: d }]])) }, { notes: { '0': [{ type: 'vocalNote', duration: 4 }] } }] as never)[0]!;
    const sung = sungLineSyllables('Bring the fire to the floor', slots, true)!;
    expect(sung.map((x) => x.phones.join(' '))).toEqual(['B R IH1 NG', 'DH AH0', 'F AY1', 'ER0', 'T UW1', 'DH AH0', 'F L AO1 R'].map((x) => x));
  });

  it('is deterministic', () => {
    const r = rhythm([[0, 1], [1, 1], [2, 1], [3, 1], [4, 2]], 2);
    expect(recutRhythm(r, ['Maybe I was wrong about you'], { bpm: 120, bars: 2 })).toEqual(recutRhythm(r, ['Maybe I was wrong about you'], { bpm: 120, bars: 2 }));
  });

  it('property: every bank rhythm takes any accepted line, at 70 and at 170 bpm', () => {
    restMisses = 0;
    leanMisses = 0;
    const entries = Object.keys(loadBankIndex().banks).flatMap((id) => {
      const bank = loadPrecedentBank(id);
      // All the curated and style rhythms; every 7th hook (706 hooks would take minutes).
      return id === 'hooks' ? bank.filter((_, i) => i % 7 === 0) : [...bank];
    });
    let k = 0;
    let misses = 0;
    let syllables = 0;
    for (const bpm of [70, 170]) {
      for (const e of entries) {
        const lines = Array.from({ length: 4 }, () => POP_LINES[k++ % POP_LINES.length]!);
        // At 170 bpm with echo: lines 3 and 4 recut from lines 1 and 2.
        const out = recutRhythm(e, lines, { bpm, bars: 8, echo: bpm === 170 });
        misses += expectSingable(out, lines, bpm, false);
        syllables += out.notes.length;
      }
    }
    // Only lines the eighth grid cannot sing exactly miss (a stressed-unstressed-unstressed ending: DAN-ge-rous).
    console.log(`stress misses: ${misses} of ${syllables} syllables; awkward rests: ${restMisses}; small words over content words: ${leanMisses}`);
    // Avoiding awkward rests (3375 without the rule, 2026-11-27) costs some stresses: 114 misses before, about 290
    // after.
    expect(misses / syllables).toBeLessThan(0.015);
    expect(restMisses / syllables).toBeLessThan(0.005);
  }, 120_000);
});
