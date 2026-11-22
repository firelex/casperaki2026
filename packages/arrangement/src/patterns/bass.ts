// Bass — legacy SM (Simple/Manual) pattern bank lowered into typed brain
// note events. Replaces the Phase 3-step 6 hand-authored root-pulse with
// a faithful slice of the legacy SMBassPatternGeneratorClass + per-genre
// SM banks (see docs/53v).
//
// For every segment that includes Bass in its activity table:
//   1. Fork `ctx.rng.fork('patterns/bass')` (step 6 determinism contract:
//      every family owns its own salt so adding/removing a family or a
//      generator step never shifts another family's stream).
//   2. Resolve the genre → SM style → pattern list via `bank-index.json`.
//   3. Deterministically pick one 2-bar pattern.
//   4. Walk the pattern's `[position, duration, semitoneOffset]` hits.
//      For every segment bar that aligns with the pattern bar (modulo
//      `patternBars`), look up the chord at `(bar, floor(beat))`, take
//      its root in MIDI octave `rootMidiOctave`, add `semitoneOffset`,
//      and emit a `type: 'note'` event.
//
// The chord lookup mirrors the legacy
// `Tools.getChordBaseNote(chords[bar][Math.floor(hit)])` — i.e. the
// first chord of the *beat* the hit lands on, not the first chord of
// the bar. SM patterns can therefore harmonically follow on-beat chord
// changes inside a bar.

import { parseChord, parseKey } from '@casperaki/music-theory';
import { MidiNoteSchema, type Segment } from '@casperaki/song-schema';

import type { GeneratorContext } from '../context.js';
import { authoredBassStylesFor, BASS_BEATS_PER_LEGACY_BAR, chordRelativeSelection, selectBassPattern } from './bass-bank.js';
import { bassPreviewFromParams } from './proposals.js';
import { nearestRootDelta } from './pad.js';
import {
  selectHipHopBassPattern,
  selectRealBassPattern,
  type RealBassSelection,
} from './bass-generators.js';
import { addNoteEvent, emptyBarPattern } from './shared.js';
import type { BarPattern, FamilyPattern, InstrumentFamily } from './types.js';

export function generateBassPattern(
  ctx: GeneratorContext,
  segment: Segment,
  activity: readonly InstrumentFamily[],
  drumPattern: FamilyPattern | undefined,
  /** Every chord root the song uses (all sections): the octave lift is decided on where the line really lands. */
  songChordRoots: ReadonlySet<number>,
): FamilyPattern | undefined {
  if (!activity.includes('bass')) return undefined;
  const rng = ctx.rng.fork('patterns/bass');

  // to-do #2 — real generator dispatch (legacy genre -> style -> generator):
  // SimpleBass / edmSimple / edmComplex / Library / HipHop. `urban` derives a
  // legato bass from the segment's drum pattern (HipHopBass); without one (no
  // drums this segment) it falls back to the orphan SM bank.
  const scale = parseKey(ctx.params.key).mode;
  let real: RealBassSelection | null = null;
  // Pattern lab: a preview forces the proposed patterns.
  const preview = bassPreviewFromParams(ctx.params.params);
  // Approved Casperaki-written styles join the genre's legacy styles. The
  // draw only happens when a genre has some, so other songs are unchanged.
  const authored = preview ? [] : authoredBassStylesFor(ctx.params.genre);
  const useAuthored = authored.length > 0 && rng.next() < authored.length / (authored.length + 1);
  if (preview) {
    real = { mode: 'chordRelative', ...chordRelativeSelection(rng, 'preview', preview.patterns) };
  } else if (useAuthored) {
    const style = rng.pick(authored);
    real = { mode: 'chordRelative', ...chordRelativeSelection(rng, style.styleName, style.patterns) };
  } else if (ctx.params.genre === 'urban' && drumPattern) {
    real = selectHipHopBassPattern(rng, drumPattern, rng.pick([1, 2, 3] as const));
  } else {
    real = selectRealBassPattern(rng, ctx.params.genre, scale);
  }
  const selection: RealBassSelection =
    real ?? {
      mode: 'chordRelative',
      ...selectBassPattern(rng, ctx.params.genre),
    };

  const bars: BarPattern[] = segment.bars.map(() => emptyBarPattern());

  // Casperaki rules (owner, 2026-11-22; not in the legacy), decided once per
  // song on the C-template line moved to the song's own chord roots (so the
  // line keeps one octave in every section):
  // - When many of its notes (over 15%) would fall below E1 (MIDI 28, a
  //   bass's lowest string), the whole line plays an octave higher (again if
  //   needed): a low line, not a line with stray high notes.
  // - The few notes still below E1 then go up an octave on their own: they
  //   land inside the line's register.
  // - Sub basses (edmSimple, written in octave 1 on purpose) keep their
  //   register, floored at C1 (MIDI 24).
  const sub = selection.styleName === 'edmSimple';
  if (songChordRoots.size === 0) throw new Error('generateBassPattern: the song has no chords');
  const roots = [...songChordRoots];
  const template = templateNotes(selection);
  const shareBelow = (lift: number) =>
    template.length === 0
      ? 0
      : template.reduce((n, t) => n + roots.filter((r) => t.midi + nearestRootDelta(r - t.root) + lift < LOWEST_BASS_STRING).length, 0) /
        (template.length * roots.length);
  let lift = 0;
  while (!sub && shareBelow(lift) > LOW_SHARE_TO_LIFT_LINE) lift += 12;
  const floor = sub ? SUB_BASS_FLOOR : LOWEST_BASS_STRING;
  const floorSub = (pitch: number) => {
    let p = pitch;
    while (p < floor) p += 12;
    return p;
  };

  // Absolute (edmComplex / Library) — chord-independent MIDI events repeated
  // modulo the pattern's bar count across the segment.
  if (selection.mode === 'absolute') {
    const barRoots = absoluteBarRoots(selection.events);
    for (let segBarIdx = 0; segBarIdx < bars.length; segBarIdx++) {
      const patternBar = segBarIdx % selection.patternBars;
      for (const ev of selection.events) {
        if (ev.bar !== patternBar) continue;
        // Legacy bank lines are C-template lines (no chords reach the bass
        // generator: BassPatternGeneratorClass.js:77-84) sent as plain notes,
        // which the engine moves from C to each chord's root the nearest way
        // (Tonal.h getSimpleNote). So the line follows the chords.
        const chordsThisBar = segment.bars[segBarIdx]!.chords;
        const chordSymbol = chordsThisBar[Math.floor(ev.beat)] ?? chordsThisBar[0];
        if (!chordSymbol) throw new Error(`generateBassPattern: segment "${segment.name}" bar ${segBarIdx} has no chords`);
        // Re-rooted per bar: the bar's own root (its first note) moves to the
        // chord root the nearest way, so a line that walks its own chords
        // follows the song's instead (see templateNotes).
        let pitch = floorSub(ev.midi + nearestRootDelta(parseChord(chordSymbol).root - barRoots.get(ev.bar)!) + lift);
        while (pitch < 0) pitch += 12;
        while (pitch > 127) pitch -= 12;
        const note = MidiNoteSchema.parse(pitch);
        addNoteEvent(bars[segBarIdx]!, ev.beat, { type: 'note', note, duration: ev.duration });
      }
    }
    return { bars: bars.map(oneNotePerBeat) };
  }

  // Chord-relative (SimpleBass / edmSimple / SM fallback).
  const rootBaseMidi = (selection.rootMidiOctave + 1) * 12;

  for (const [position, duration, semitoneOffset] of selection.pattern) {
    if (position < 0) continue;
    const patternBar = Math.floor(position / BASS_BEATS_PER_LEGACY_BAR);
    const beat = position - patternBar * BASS_BEATS_PER_LEGACY_BAR;
    if (beat < 0 || beat >= BASS_BEATS_PER_LEGACY_BAR) continue;
    for (let segBarIdx = 0; segBarIdx < bars.length; segBarIdx++) {
      if (segBarIdx % selection.patternBars !== patternBar) continue;
      const chordsThisBar = segment.bars[segBarIdx]!.chords;
      const beatOfChord = Math.floor(beat);
      const chordSymbol = chordsThisBar[beatOfChord] ?? chordsThisBar[0];
      if (!chordSymbol) {
        throw new Error(
          `generateBassPattern: segment "${segment.name}" bar ${segBarIdx} has no chords`,
        );
      }
      // Legacy builds the hit on its default all-C template ('C' + octave +
      // offset) and the engine moves the plain note from C to the chord root
      // the nearest way (-5..+6), not upwards: roots G..B sit below C.
      const root = parseChord(chordSymbol).root;
      const raw = floorSub(rootBaseMidi + nearestRootDelta(root) + semitoneOffset + lift);
      // Clamp into MidiNote range. SM patterns can use offsets like
      // `-5` / `+7` / `+12` that, combined with extreme chord roots,
      // would theoretically push out of [0, 127]. Octave-shift back in
      // by 12 until it fits; the legacy code wraps via a similar
      // chromatic table fallback (see SMBassPatternGeneratorClass's
      // Tools.notes lookup).
      let pitch = raw;
      while (pitch < 0) pitch += 12;
      while (pitch > 127) pitch -= 12;
      const note = MidiNoteSchema.parse(pitch);
      addNoteEvent(bars[segBarIdx]!, beat, {
        type: 'note',
        note,
        duration,
      });
    }
  }

  return { bars: bars.map(oneNotePerBeat) };
}

/**
 * A bass plays one note at a time: where several notes start on the same beat
 * (bank lines carry 1/16 grace notes stacked on a long note, and duplicates),
 * keep the longest (ties: the lowest). Casperaki data rule, not in the legacy.
 */
function oneNotePerBeat(bar: BarPattern): BarPattern {
  const notes: BarPattern['notes'] = {};
  for (const [beat, events] of Object.entries(bar.notes)) {
    if (!events) continue;
    if (events.length <= 1) {
      notes[beat as keyof typeof notes] = events;
      continue;
    }
    const best = [...events].sort((a, b) => {
      const da = (a as { duration?: number }).duration ?? 0;
      const db = (b as { duration?: number }).duration ?? 0;
      return db - da || Number((a as { note?: number }).note) - Number((b as { note?: number }).note);
    })[0]!;
    notes[beat as keyof typeof notes] = [best];
  }
  return { ...bar, notes };
}

/**
 * Each bar's own root in a bank line: the pitch class of the lowest note at
 * the bar's first hit. Half the Library lines walk their own chords (a bar on
 * C, a bar on A …); the legacy moved every note from C to the song chord, which
 * shifted those bars twice. Re-rooting each bar keeps one-chord lines exactly
 * as the legacy played them and makes walking lines follow the song's chords.
 */
function absoluteBarRoots(events: readonly { bar: number; beat: number; midi: number }[]): Map<number, number> {
  const first = new Map<number, { beat: number; midi: number }>();
  for (const e of events) {
    const cur = first.get(e.bar);
    if (!cur || e.beat < cur.beat || (e.beat === cur.beat && e.midi < cur.midi)) first.set(e.bar, { beat: e.beat, midi: e.midi });
  }
  return new Map([...first].map(([bar, f]) => [bar, ((f.midi % 12) + 12) % 12]));
}

/** E1: the lowest string of a (4-string) bass. */
const LOWEST_BASS_STRING = 28;
/** C1: the lowest note a sub bass plays. */
const SUB_BASS_FLOOR = 24;
/** Share of a line's notes below E1 above which the whole line goes up an octave. */
const LOW_SHARE_TO_LIFT_LINE = 0.15;

/** The bass line's notes on its template, each with the root it is moved from (C, or its bar's own root for bank lines). */
function templateNotes(selection: RealBassSelection): { midi: number; root: number }[] {
  if (selection.mode === 'absolute') {
    const barRoots = absoluteBarRoots(selection.events);
    return selection.events.map((e) => ({ midi: e.midi, root: barRoots.get(e.bar)! }));
  }
  const base = (selection.rootMidiOctave + 1) * 12;
  return selection.pattern.filter(([position]) => position >= 0).map(([, , offset]) => ({ midi: base + offset, root: 0 }));
}
