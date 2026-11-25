// Written lyrics: lines of words (from the language model, written by the brain) checked against the melody and
// attached to the vocal notes, one syllable per note (docs/superpowers/specs/2026-11-24-written-lyrics-design.md).
//
// Pronunciations come from casperaki2's CMU-based dictionary (data/lyrics/pronunciations.json.gz, built by
// scripts/build-pronunciations.mjs): per word its written syllables and ARPAbet phonemes per syllable, the vowel
// carrying its stress (1 primary, 2 secondary, 0 none).
//
// Recorded in the generator block as `params.lyrics` (section name → lines); `writeVocals` attaches them in place of
// the phrase bank.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { z } from 'zod';

import { lyricLines, lyricSlots, rhymeScheme, type LyricLine, type LyricSlot } from './lyric-lines.js';
import { formatBarBeat } from '@casperaki/music-theory';
import { BarBeatSchema } from '@casperaki/song-schema';

import type { VocalBar, VocalNoteEvent, VocalSegment } from './types.js';

export const WRITTEN_LYRICS_PARAM = 'lyrics';
/** Section name (as the generator names it) → its lyric lines, one per lyric line of its melody. */
export const WrittenLyricsSchema = z.record(z.string().min(1), z.array(z.string().min(1)).min(1));
export type WrittenLyrics = z.infer<typeof WrittenLyricsSchema>;

/** The written lyrics in generator params (empty when the key is absent). */
export function writtenLyricsOf(params: Readonly<Record<string, unknown>> | undefined): WrittenLyrics {
  const raw = params?.[WRITTEN_LYRICS_PARAM];
  if (raw === undefined) return {};
  return WrittenLyricsSchema.parse(raw);
}

// ---- pronunciations ---------------------------------------------------------------------------------------------

interface Pronunciation {
  /** Written syllables ("to", "night"). */
  readonly syllables: readonly string[];
  /** ARPAbet per syllable, uppercase with stress digits (["T", "AH0"], ["N", "AY1", "T"]). */
  readonly phones: readonly (readonly string[])[];
  /** Stress per syllable: 1 primary, 2 secondary, 0 none. */
  readonly stress: readonly number[];
}

const DictSchema = z.object({ $schemaVersion: z.literal(1), $source: z.string(), words: z.record(z.string(), z.tuple([z.array(z.string()), z.array(z.string())])) }).strict();

let dict: Map<string, readonly [readonly string[], readonly string[]]> | undefined;

function dictionary(): Map<string, readonly [readonly string[], readonly string[]]> {
  if (dict) return dict;
  const path = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'lyrics', 'pronunciations.json.gz');
  const parsed = DictSchema.parse(JSON.parse(gunzipSync(readFileSync(path)).toString('utf8')));
  dict = new Map(Object.entries(parsed.words));
  return dict;
}

/** The word as the dictionary spells it, or undefined when it is not there. */
function dictionaryKey(word: string): string | undefined {
  const w = word.toLowerCase().replace(/[‘’`]/gu, "'").replace(/[^a-z']/gu, '');
  const d = dictionary();
  for (const k of [w, w.replace(/^'+|'+$/gu, ''), w.replace(/'+$/u, '')]) if (k && d.has(k)) return k;
  return undefined;
}

export function pronounce(word: string): Pronunciation | undefined {
  const key = dictionaryKey(word);
  if (!key) return undefined;
  const [syllables, phonemeSyllables] = dictionary().get(key)!;
  const phones = phonemeSyllables.map((s) => s.split(' '));
  const stress = phones.map((ps) => Number(ps.find((p) => /\d$/u.test(p))!.slice(-1)));
  return { syllables, phones, stress };
}

/** The words of a line of text: split at spaces and dashes, punctuation dropped (apostrophes kept). */
export function wordsOf(text: string): string[] {
  return text
    .replace(/[‘’`]/gu, "'")
    .split(/[\s\-–—/]+/u)
    .map((w) => w.replace(/^[^A-Za-z']+|[^A-Za-z']+$/gu, ''))
    .filter((w) => /[A-Za-z]/u.test(w));
}

// ---- checking a line against its notes --------------------------------------------------------------------------

export interface SungSyllable {
  /** Display form: the word's first syllable capitalised, "-" on a non-final syllable ("To-", "night"). */
  readonly fullWord: string;
  /** Lowercase ARPAbet ("n", "ay1", "t"). */
  readonly vocaloidPhonemes: readonly string[];
}

interface ParsedWord {
  readonly word: string;
  readonly p: Pronunciation;
  /** The word as it is often sung, one syllable shorter ("ev'ry", "fire" in one), when it has such a form. */
  readonly short?: Pronunciation;
}

// ---- sung contractions ------------------------------------------------------------------------------------------
//
// Words singers often sing one syllable shorter. MERGE_LAST: the last syllable runs into the one before ("fi-re" →
// "fire", "be-ing" → "being" in one). DROP_INNER: the first unstressed inner syllable loses its vowel ("e-ve-ry" →
// "ev-ry", "fa-mi-ly" → "fam-ly").
const MERGE_LAST = new Set(['fire', 'fires', 'desire', 'higher', 'liar', 'hour', 'hours', 'our', 'flower', 'flowers', 'power', 'powers', 'tower', 'shower', 'tired', 'being', 'prayer', 'player', 'layer', 'quiet', 'diamond', 'diamonds', 'violet', 'science', 'lion']);
const DROP_INNER = new Set(['every', 'everything', 'everyone', 'everybody', 'everywhere', 'everyday', 'different', 'difference', 'family', 'families', 'memory', 'memories', 'favorite', 'history', 'mystery', 'chocolate', 'evening', 'camera', 'natural', 'general', 'several', 'interest', 'interesting', 'separate', 'temperature', 'comfortable', 'average', 'beautiful', 'heaven', 'heavenly', 'easily', 'restaurant', 'vegetable', 'traveling', 'wandering', 'wondering', 'whispering', 'listening', 'opening', 'shimmering', 'glittering', 'flickering', 'trembling']);

const isVowel = (ph: string) => /\d$/u.test(ph);
const stressOf = (ps: readonly string[]) => Number(ps.find(isVowel)!.slice(-1));
/** A vowel losing its syllable: ER becomes the consonant R, any other vowel goes. */
const unvowel = (ps: readonly string[]) => ps.flatMap((x) => (isVowel(x) ? (x.startsWith('ER') ? ['R'] : []) : [x]));

function shortForm(key: string, p: Pronunciation): Pronunciation | undefined {
  const n = p.syllables.length;
  if (n < 2) return undefined;
  if (MERGE_LAST.has(key)) {
    const phones = [...p.phones.slice(0, n - 2), [...p.phones[n - 2]!, ...unvowel(p.phones[n - 1]!)]];
    const syllables = [...p.syllables.slice(0, n - 2), p.syllables[n - 2]! + p.syllables[n - 1]!];
    return { syllables, phones, stress: phones.map(stressOf) };
  }
  if (DROP_INNER.has(key)) {
    const i = p.stress.findIndex((st, j) => st === 0 && j > 0 && j < n - 1);
    if (i < 0) return undefined;
    const phones = p.phones.flatMap((ps, j) => (j === i ? [] : j === i + 1 ? [[...unvowel(p.phones[i]!), ...ps]] : [ps]));
    const syllables = p.syllables.flatMap((t, j) => (j === i ? [] : j === i + 1 ? [p.syllables[i]! + t] : [t]));
    return { syllables, phones, stress: phones.map(stressOf) };
  }
  return undefined;
}

/** The line's words with their pronunciations, or the words the dictionary does not know. */
function parseLine(text: string): { words: ParsedWord[]; unknown: string[] } {
  const words: ParsedWord[] = [];
  const unknown: string[] = [];
  for (const word of wordsOf(text)) {
    const p = pronounce(word);
    if (!p) {
      unknown.push(word);
      continue;
    }
    const short = shortForm(dictionaryKey(word)!, p);
    words.push({ word, p, ...(short ? { short } : {}) });
  }
  return { words, unknown };
}

const titleCase = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** The line's pronunciations with the first `shorten` words that have a sung short form using it. */
function variant(words: readonly ParsedWord[], shorten: number): { word: string; p: Pronunciation }[] {
  let left = shorten;
  return words.map((w) => {
    if (left > 0 && w.short) {
      left--;
      return { word: w.word, p: w.short };
    }
    return { word: w.word, p: w.p };
  });
}

function syllablesOf(words: readonly { p: Pronunciation }[]): SungSyllable[] {
  return words.flatMap(({ p }) =>
    p.syllables.map((s, i) => ({
      fullWord: `${i === 0 ? titleCase(s) : s}${i < p.syllables.length - 1 ? '-' : ''}`,
      vocaloidPhonemes: p.phones[i]!.map((x) => x.toLowerCase()),
    })),
  );
}

/** The words split into their syllables as the dictionary has them ("sun·rise on my street"). */
const spelled = (words: readonly { p: Pronunciation }[]) => words.map(({ p }) => p.syllables.join('·')).join(' ');

// ---- fitting a line to its notes --------------------------------------------------------------------------------
//
// A line may have a few syllables fewer than notes: spare notes hold the syllable before them (a slur, one syllable
// over two notes). Only a note that follows the one before it without a gap can be held; weak and short notes are
// held first, later in the line before earlier. A line may also have a syllable or two more than notes: the longest
// notes (a beat or more) are split in two halves at the same pitch, later notes first.

const EPS = 1e-6;
const MAX_HELD = 3;
const MAX_SPLIT = 2;

function holdable(slots: LyricLine): number[] {
  const out: { i: number; score: number }[] = [];
  for (let i = 1; i < slots.length; i++) {
    const prev = slots[i - 1]!;
    if (slots[i]!.start - (prev.start + prev.duration) > EPS) continue;
    out.push({ i, score: (slots[i]!.strong ? 0 : 2) + (slots[i]!.duration <= 0.5 + EPS ? 1 : 0) + i / slots.length });
  }
  return out.sort((a, b) => b.score - a.score).map((h) => h.i);
}

function splittable(slots: LyricLine): number[] {
  return slots
    .map((s, i) => ({ i, d: s.duration }))
    .filter((x) => x.d >= 1 - EPS)
    .sort((a, b) => b.d - a.d || b.i - a.i)
    .map((x) => x.i);
}

/** The notes that sing a new syllable (after holds and splits), in order. */
interface SungNote {
  readonly start: number;
  readonly duration: number;
  readonly strong: boolean;
  /** Index of the line slot it comes from. */
  readonly slot: number;
}

interface LinePlan {
  readonly words: { word: string; p: Pronunciation }[];
  readonly syllables: SungSyllable[];
  readonly held: ReadonlySet<number>;
  readonly split: ReadonlySet<number>;
}

const maxHeld = (slots: LyricLine) => Math.min(holdable(slots).length, Math.floor(slots.length / 4), MAX_HELD);
const maxSplit = (slots: LyricLine) => Math.min(splittable(slots).length, slots.length >= 8 ? MAX_SPLIT : 1);

/** How the words fit the notes: exactly, else with sung short forms, else holding or splitting notes (fewest changes
 *  first); undefined when they cannot fit. */
function planLine(words: readonly ParsedWord[], slots: LyricLine): LinePlan | undefined {
  const shortenable = words.filter((w) => w.short).length;
  let best: { plan: LinePlan; cost: number } | undefined;
  for (let k = 0; k <= shortenable; k++) {
    const v = variant(words, k);
    const syllables = syllablesOf(v);
    const diff = syllables.length - slots.length;
    let plan: LinePlan | undefined;
    if (diff === 0) plan = { words: v, syllables, held: new Set(), split: new Set() };
    else if (diff < 0 && -diff <= maxHeld(slots)) plan = { words: v, syllables, held: new Set(holdable(slots).slice(0, -diff)), split: new Set() };
    else if (diff > 0 && diff <= maxSplit(slots)) plan = { words: v, syllables, held: new Set(), split: new Set(splittable(slots).slice(0, diff)) };
    if (!plan) continue;
    const cost = k * 0.5 + Math.abs(diff) * (diff > 0 ? 1.5 : 1);
    if (!best || cost < best.cost) best = { plan, cost };
  }
  return best?.plan;
}

function sungNotes(slots: LyricLine, plan: LinePlan): SungNote[] {
  const out: SungNote[] = [];
  slots.forEach((s, i) => {
    if (plan.held.has(i)) return;
    if (plan.split.has(i)) {
      const half = s.duration / 2;
      out.push({ start: s.start, duration: half, strong: s.strong, slot: i }, { start: s.start + half, duration: half, strong: false, slot: i });
    } else out.push({ start: s.start, duration: s.duration, strong: s.strong, slot: i });
  });
  return out;
}

/** Multi-syllable words sung against the beat: the stressed syllable on a weak note while an unstressed one of the
 *  same word is on a strong note. */
function stressClashes(words: readonly { word: string; p: Pronunciation }[], sung: readonly SungNote[]): string[] {
  const clashes: string[] = [];
  let at = 0;
  for (const { word, p } of words) {
    if (p.syllables.length > 1) {
      const primary = p.stress.indexOf(1);
      const sl = sung.slice(at, at + p.syllables.length);
      if (primary >= 0 && sl[primary] && !sl[primary]!.strong && p.stress.some((st, i) => st === 0 && sl[i]?.strong)) clashes.push(word);
    }
    at += p.syllables.length;
  }
  return clashes;
}

/** Stress clashes a line may have before it is sent back. */
const MAX_STRESS_CLASHES = 1;

/** A note this long (beats) or longer is held: the syllable it ends on must end its word. */
export const HOLD_BEATS = 2;

/** Words cut across a held note: the last syllable sung on (or carried over) a held note is not the end of its word,
 *  so the singer would stop mid-word ("sun-rise" with "sun" held). Each as the word with "·" between its syllables. */
function heldNoteCuts(plan: LinePlan, slots: LyricLine): string[] {
  const sung = sungNotes(slots, plan);
  // Which word each sung syllable belongs to.
  const wordOf: number[] = plan.words.flatMap(({ p }, w) => p.syllables.map(() => w));
  const cuts: string[] = [];
  slots.forEach((s, i) => {
    if (s.duration < HOLD_BEATS - EPS) return;
    // The last syllable on this note: its own (the second half's, if split), or the one it carries on when held.
    let k = -1;
    sung.forEach((n, j) => {
      if (n.slot <= i) k = j;
    });
    if (k < 0) return;
    if (plan.syllables[k]!.fullWord.endsWith('-')) {
      const w = plan.words[wordOf[k]!]!;
      cuts.push(`"${w.p.syllables.join('·')}" (held on "${w.p.syllables[k - wordOf.indexOf(wordOf[k]!)]}")`);
    }
  });
  return cuts;
}

// ---- rhyme ------------------------------------------------------------------------------------------------------

/** Vowels a pop rhyme treats as one: "on" / "gone" (AA, AO); before R, "near" / "here", "sure" / "pure",
 *  "there" / "chair". */
function normalVowel(v: string, next: string | undefined): string {
  if (v === 'AO') return 'AA';
  if (next === 'R') return ({ IH: 'IY', UH: 'UW', EY: 'EH' } as Record<string, string>)[v] ?? v;
  return v;
}

/** The rhyming part of a word: its vowels from the last stressed one on, and all its sounds from there. */
function rhymeKey(p: Pronunciation): { vowels: string; tail: string } {
  const flat = p.phones.flat();
  let from = -1;
  for (let i = flat.length - 1; i >= 0 && from < 0; i--) if (/[12]$/u.test(flat[i]!)) from = i;
  for (let i = flat.length - 1; i >= 0 && from < 0; i--) if (isVowel(flat[i]!)) from = i;
  const part = flat.slice(from);
  const norm = part.map((x, i) => (isVowel(x) ? normalVowel(x.replace(/\d$/u, ''), part[i + 1]) : x));
  const vowels = part.flatMap((x, i) => (isVowel(x) ? [norm[i]!] : [])).join(' ');
  return { vowels, tail: norm.join(' ') };
}

/** Pop-song rhyme: the same vowel sounds from the last stressed one on, whatever the consonants ("time" / "mind",
 *  "now" / "out", "fire" / "higher"); never the same word. */
export function wordsRhyme(a: string, b: string): boolean {
  const ka = dictionaryKey(a);
  const kb = dictionaryKey(b);
  if (!ka || !kb || ka === kb) return false;
  const ra = rhymeKey(pronounce(a)!);
  const rb = rhymeKey(pronounce(b)!);
  return ra.tail === rb.tail || ra.vowels === rb.vowels;
}

// ---- checking -----------------------------------------------------------------------------------------------------

export interface LineProblem {
  /** 0-based line index in the section. */
  readonly line: number;
  readonly message: string;
}

/** What is wrong with one line for its notes (plain English, for the lyricist), undefined when it fits. */
function lineProblem(text: string, slots: LyricLine): string | undefined {
  const { words, unknown } = parseLine(text);
  if (unknown.length > 0) return `These words are not in the pronunciation dictionary (use other, common English words): ${unknown.join(', ')}.`;
  const plan = planLine(words, slots);
  if (!plan) {
    const n = syllablesOf(words).length;
    const diff = n - slots.length;
    const fix = diff > 0 ? `remove ${diff} syllable${diff === 1 ? '' : 's'}` : `add ${-diff} syllable${diff === -1 ? '' : 's'}`;
    return `It has ${n} syllables (${spelled(words)}) but must have exactly ${slots.length}: ${fix}.`;
  }
  const clashes = stressClashes(plan.words, sungNotes(slots, plan));
  if (clashes.length > MAX_STRESS_CLASHES) return `These words are stressed against the beat (their stressed syllable falls on a weak note, a da): ${clashes.join(', ')}.`;
  const cuts = heldNoteCuts(plan, slots);
  if (cuts.length > 0) {
    return `A word is cut in two across a long held note (a HOLD), so the singer would stop in the middle of the word: ${cuts.join(', ')}. The syllable on a HOLD must end its word: a one-syllable word, or the last syllable of a longer word.`;
  }
  return undefined;
}

/** What is wrong with a section's lines for its melody (plain English, for the lyricist), empty when they fit. */
export function checkSectionLyrics(lines: readonly LyricLine[], text: readonly string[]): LineProblem[] {
  if (text.length !== lines.length) return [{ line: -1, message: `The section needs exactly ${lines.length} lines, but ${text.length} were written.` }];
  const problems: LineProblem[] = [];
  text.forEach((t, i) => {
    const message = lineProblem(t, lines[i]!);
    if (message) problems.push({ line: i, message });
  });
  // Rhymes (ABCB): each line with the first line of its rhyme group.
  const scheme = rhymeScheme(lines.length);
  const lastWord = (t: string) => wordsOf(t).at(-1);
  scheme.forEach((letter, i) => {
    const first = scheme.indexOf(letter);
    if (first === i) return;
    const a = lastWord(text[first]!);
    const b = lastWord(text[i]!);
    if (!a || !b || !pronounce(a) || !pronounce(b)) return;
    if (dictionaryKey(a) === dictionaryKey(b)) {
      problems.push({
        line: i,
        message: `Lines ${first + 1} and ${i + 1} must rhyme, but both end on the same word, "${b}": a word may not rhyme with itself. Rewrite line ${i + 1}, or both lines, so they end on two different words that rhyme.`,
      });
    } else if (!wordsRhyme(a, b)) {
      problems.push({
        line: i,
        message: `Lines ${first + 1} and ${i + 1} must rhyme, but their last words "${a}" and "${b}" do not (a rhyme has the same vowel sound and a similar ending, and is not the same word). Rewrite line ${i + 1}, or both lines, so they end on rhyming words.`,
      });
    }
  });
  return problems;
}

/** A held note: it carries on the syllable before it ("-", that syllable's phonemes). */
export const HELD_SYLLABLE = '-';

/** What the line's notes sing: per sung note its start, length and syllable (an error naming the line otherwise). */
function fitLine(text: string, slots: LyricLine, where: string): { start: number; duration: number; slot: number; syl: SungSyllable }[] {
  const { words, unknown } = parseLine(text);
  if (unknown.length > 0) throw new Error(`${where}: words not in the pronunciation dictionary: ${unknown.join(', ')}`);
  const plan = planLine(words, slots);
  if (!plan) throw new Error(`${where}: "${text}" does not fit its ${slots.length} notes`);
  const sung = sungNotes(slots, plan);
  const out: { start: number; duration: number; slot: number; syl: SungSyllable }[] = sung.map((n, k) => ({ start: n.start, duration: n.duration, slot: n.slot, syl: plan.syllables[k]! }));
  // Held notes carry the syllable before them.
  slots.forEach((s, i) => {
    if (!plan.held.has(i)) return;
    const before = [...out].filter((o) => o.start < s.start - EPS).sort((a, b) => b.start - a.start)[0]!;
    out.push({ start: s.start, duration: s.duration, slot: i, syl: { fullWord: HELD_SYLLABLE, vocaloidPhonemes: before.syl.vocaloidPhonemes } });
  });
  return out.sort((a, b) => a.start - b.start);
}

const BEATS_PER_BAR = 4;
export const beatKey = (start: number) => {
  const inBar = start - Math.floor(start / BEATS_PER_BAR + EPS) * BEATS_PER_BAR;
  const b = Math.round(inBar * 1e6) / 1e6;
  return formatBarBeat(b);
};

/** The segment with the written lines sung on its notes (an error when a line does not fit its notes). A split note
 *  becomes two notes; the second half is a copy of it. */
export function attachWrittenLyrics(segment: VocalSegment, text: readonly string[]): VocalSegment {
  const lines = lyricLines(segment.bars);
  if (text.length !== lines.length) {
    throw new Error(`written lyrics for ${segment.segmentName}: ${text.length} lines written for ${lines.length} lyric lines of its melody`);
  }
  // Every vocal note by its start (beats from the section start).
  const original = new Map<number, VocalNoteEvent>();
  const startOf = (barIndex: number, beat: string) => Math.round((barIndex * BEATS_PER_BAR + Number.parseFloat(beat)) * 1e6);
  const bars: VocalBar[] = segment.bars.map((bar, barIndex) => {
    const notes: VocalBar['notes'] = {};
    for (const [beat, evs] of Object.entries(bar.notes)) {
      const kept = (evs ?? []).filter((ev) => {
        if (ev.type !== 'vocalNote') return true;
        original.set(startOf(barIndex, beat), ev);
        return false;
      });
      if (kept.length > 0) notes[beat as keyof typeof notes] = kept;
    }
    return { ...bar, notes };
  });
  lines.forEach((slots, i) => {
    const fitted = fitLine(text[i]!, slots, `written lyrics for ${segment.segmentName}, line ${i + 1}`);
    fitted.forEach((f, k) => {
      const slot = slots[f.slot]!;
      const ev = original.get(Math.round(slot.start * 1e6));
      if (!ev) throw new Error(`written lyrics for ${segment.segmentName}: no vocal note at bar ${slot.barIndex + 1} beat ${slot.beat}`);
      const lastOfSlot = fitted[k + 1]?.slot !== f.slot;
      const { endOfPhrase, ...rest } = ev;
      const next: VocalNoteEvent = {
        ...rest,
        duration: f.duration,
        fullWord: f.syl.fullWord,
        vocaloidPhonemes: [...f.syl.vocaloidPhonemes],
        ...(endOfPhrase !== undefined && lastOfSlot ? { endOfPhrase } : {}),
      };
      const barIndex = Math.floor(f.start / BEATS_PER_BAR + EPS);
      const bar = bars[barIndex];
      if (!bar) throw new Error(`written lyrics for ${segment.segmentName}: a note falls outside the section`);
      const key = BarBeatSchema.parse(beatKey(f.start));
      (bar.notes[key] ??= []).push(next);
    });
  });
  return { ...segment, bars };
}

export type { LyricLine, LyricSlot };
export { lyricLines, lyricSlots, rhymeScheme };
