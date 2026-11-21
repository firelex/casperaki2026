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
  drumPattern?: FamilyPattern,
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

  // Absolute (edmComplex / Library) — chord-independent MIDI events repeated
  // modulo the pattern's bar count across the segment.
  if (selection.mode === 'absolute') {
    for (let segBarIdx = 0; segBarIdx < bars.length; segBarIdx++) {
      const patternBar = segBarIdx % selection.patternBars;
      for (const ev of selection.events) {
        if (ev.bar !== patternBar) continue;
        const note = MidiNoteSchema.parse(ev.midi);
        addNoteEvent(bars[segBarIdx]!, ev.beat, { type: 'note', note, duration: ev.duration });
      }
    }
    return { bars };
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
      const root = parseChord(chordSymbol).root;
      const raw = rootBaseMidi + root + semitoneOffset;
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

  return { bars };
}
