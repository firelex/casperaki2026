// Step 17d — backing vocal generator.
//
// Legacy source:
//   casperaki2-engine-js/api/v1.0/services/classes/vocals/MelodyClass.js
//     lines 26-28    → backingVocalsMelodyPitchOffset table
//     lines 296-321  → activity gate (chorus → backing 1/2 on; schlager
//                      intro+chorus → schlager support on)
//     lines 339-398  → `_getBackingVocals(segmentIndex, pattern, offset)`
//                      (deep-clone -> shift by ±4 -> findClosestChordNote)
//     lines 3167-3296→ in-line pass with the octave-drop guard
//     lines 3298-3359→ standalone `getBackingVocals` route (same loop)
//   casperaki2-engine-js/api/v1.0/services/tools.js
//     lines 614-633  → `findClosestChordNote(chord, note)` — picks the
//                      pitch in the chord's chord-tone set closest to the
//                      shifted note.
//
// Brain port surface — a pure function over `VocalResult` + `SongStructure`:
//   generateBackings(lead, structure, { pitchOffset, maxNote? }) -> VocalSegment[]
//
// Per the 53af plan we land lanes 1 (-4) and 2 (+4) as separate calls. The
// schlager support lane is a later subphase; this module does not emit it
// (the input cannot tell the schlager-specific case apart from a generic
// chorus run; the per-genre activity rule is the same as legacy for the
// two lanes — chorus + bridge, lead vocals present).
//
// Determinism:
//   No `rng` draws. Every choice is a deterministic function of the lead
//   pitches + the segment chord stream. This matches the legacy code
//   exactly (legacy did not consume randomness in `_getBackingVocals`).
//
// Lyric inheritance:
//   The legacy code starts from a deep clone of the lead pattern (i.e.
//   `JSON.parse(JSON.stringify(...))`) — every note's `lyrics` /
//   `cmuPhonemes` / `vocaloidPhonemes` / `endOfPhrase` rides along
//   verbatim. The brain port preserves the same invariant on its own
//   schema: `fullWord`, `vocaloidPhonemes`, `endOfPhrase`, `duration`
//   come straight from the lead note.
//
// Range guard (legacy MelodyClass.js:3216-3267):
//   After the snap pass, if any backing note exceeds `this.maxNote` (= 59
//   / B4), every note in the lane is dropped by 12 semitones. Legacy
//   loops the guard at most once; if the line is STILL out of range it
//   accepts the result silently. We replicate the same behaviour.

import { parseChord } from '@casperaki/music-theory';

import { MIN_NOTE, MAX_NOTE } from './range.js';
import type { VocalBar, VocalResult, VocalSegment, VocalNoteEvent } from './types.js';

import {
  BarBeatSchema,
  MidiNoteSchema,
  type ChordSymbol,
  type Segment,
  type SongStructure,
} from '@casperaki/song-schema';

/** Pitch offsets matching the legacy `backingVocalsMelodyPitchOffset` table
 *  (MelodyClass.js:26-28). */
export const BACKING_OFFSET_1 = -4;
export const BACKING_OFFSET_2 = 4;

/** Segment-type prefixes for which backings are emitted. Mirrors the
 *  in-line gate `["chorus", "bridge"].includes(segmentType)` at
 *  MelodyClass.js:3194 (broader than the static gate at 296-321 which
 *  enables chorus only; we preserve the LIVE in-line gate per the 53af
 *  oddity list). */
const BACKING_SEGMENT_TYPES: ReadonlySet<string> = new Set(['chorus', 'bridge']);

function baseType(name: string): string {
  const m = /^[A-Za-z]+/u.exec(name);
  return m ? m[0]! : name;
}

/** True iff a segment is eligible for backing vocal generation. */
export function isBackingActiveSegment(segmentName: string): boolean {
  return BACKING_SEGMENT_TYPES.has(baseType(segmentName));
}

/** Port of legacy `Tools.findClosestChordNote` (tools.js:614-633).
 *
 *  Returns the MIDI value of the chord-tone (pitch in the chord's
 *  `chordNotes` set) closest to `midi`. Ties are broken by the lower
 *  candidate (the legacy `<` comparison preserves the first-found
 *  candidate, which is the lower-octave pass for `notes` ordered
 *  ascending; reproduced here by sweeping low → high and using `<`).
 *
 *  Chord-tone set is taken from `parseChord(symbol).intervals`. Brain's
 *  `parseChord` returns the full chord tone interval set for every
 *  quality the bank emits (including 7ths, 9ths, sus, dim) — wider than
 *  the precedents.ts stand-in which approximated with the triad. */
export function findClosestChordNote(chordSymbol: ChordSymbol | string, midi: number): number {
  const parsed = parseChord(String(chordSymbol));
  // Reduce intervals to pitch-class set (chord-tones, octave-independent).
  const pcSet = new Set<number>();
  for (const interval of parsed.intervals) {
    pcSet.add(((parsed.root + interval) % 12 + 12) % 12);
  }
  if (pcSet.size === 0) {
    // Defensive: parseChord always returns at least the root, so this
    // shouldn't be reachable. Falling back to the input keeps the
    // generator deterministic instead of throwing.
    return midi;
  }

  // Sweep a wide MIDI window centred on the target so ties break toward
  // the lower-octave candidate (matches the legacy iteration order over
  // `notes` keys ascending). Window is ±12 — by construction one chord
  // tone falls within every semitone-12 window of any pitch-class set.
  let best = -1;
  let bestDist = Infinity;
  for (let m = midi - 12; m <= midi + 12; m++) {
    const pc = ((m % 12) + 12) % 12;
    if (!pcSet.has(pc)) continue;
    const dist = Math.abs(m - midi);
    if (dist < bestDist) {
      bestDist = dist;
      best = m;
    }
  }
  return best === -1 ? midi : best;
}

export interface BackingOptions {
  /** Semitone shift applied to every lead note before chord-snap. */
  readonly pitchOffset: number;
  /** Upper MIDI bound (octave-drop guard threshold). Defaults to the
   *  legacy `MelodyClass.maxNote` (B4 / 59). */
  readonly maxNote?: number;
}

/** Generates one backing vocal lane from the lead `VocalResult` and the
 *  segment chord stream.
 *
 *  Behaviour (faithful to legacy):
 *  - Only segments whose `segmentName` baseType ∈ {chorus, bridge} are
 *    emitted. Other segments are dropped from the output entirely (the
 *    orchestrator decides what `instruments[<lane>]` flag to set).
 *  - Lead notes that are not vocal-notes (shouldn't happen in the brain
 *    today but we don't crash on it) are dropped from the backing lane.
 *  - Per note: `note.note = findClosestChordNote(barChord, leadNote + offset)`.
 *    `duration`, `fullWord`, `vocaloidPhonemes`, `endOfPhrase` are carried
 *    from the lead verbatim.
 *  - If any emitted note exceeds `maxNote`, every note in the lane is
 *    dropped by 12 semitones (octave-drop guard). Legacy attempts the
 *    drop at most once; we replicate that. */
export function generateBackings(
  lead: VocalResult,
  structure: SongStructure,
  options: BackingOptions,
): VocalSegment[] {
  const maxNote = options.maxNote ?? MAX_NOTE;
  const structureByName = new Map(structure.map((s) => [s.name, s] as const));

  const out: VocalSegment[] = [];
  for (const leadSegment of lead.segments) {
    if (!isBackingActiveSegment(leadSegment.segmentName)) continue;
    const structureSegment = structureByName.get(leadSegment.segmentName);
    if (!structureSegment) {
      // Inconsistent inputs — lead names a segment the structure doesn't.
      // Skip rather than throw; the orchestrator surfaces shape errors
      // separately.
      continue;
    }
    out.push(buildBackingSegment(leadSegment, structureSegment, options.pitchOffset, maxNote));
  }
  return out;
}

function buildBackingSegment(
  leadSegment: VocalSegment,
  structureSegment: Segment,
  pitchOffset: number,
  maxNote: number,
): VocalSegment {
  // Pass 1 — clone + chord-snap. Track max MIDI for the guard.
  const { bars: shiftedBars, maxMidi } = shiftAndSnap(
    leadSegment.bars,
    structureSegment.bars,
    pitchOffset,
  );

  if (maxMidi <= maxNote) {
    return { segmentName: leadSegment.segmentName, bars: shiftedBars };
  }

  // Pass 2 — octave-drop guard. Subtract 12 from every note in the lane.
  // Legacy stops here; if maxMidi is STILL > maxNote we accept the line
  // (see MelodyClass.js:3216-3267 — no second iteration of the drop).
  const droppedBars: VocalBar[] = shiftedBars.map((bar) => {
    const newNotes: VocalBar['notes'] = {};
    for (const [beatKey, events] of Object.entries(bar.notes)) {
      if (!events) continue;
      const key = BarBeatSchema.parse(beatKey);
      newNotes[key] = events.map((ev) => {
        if (ev.type !== 'vocalNote' || typeof ev.note !== 'number') return ev;
        return { ...ev, note: MidiNoteSchema.parse(ev.note - 12) } as VocalNoteEvent;
      });
    }
    return { notes: newNotes };
  });

  return { segmentName: leadSegment.segmentName, bars: droppedBars };
}

function shiftAndSnap(
  leadBars: readonly VocalBar[],
  structureBars: readonly Segment['bars'][number][],
  pitchOffset: number,
): { bars: VocalBar[]; maxMidi: number } {
  const outBars: VocalBar[] = [];
  let maxMidi = -Infinity;

  for (let barIndex = 0; barIndex < leadBars.length; barIndex++) {
    const bar = leadBars[barIndex]!;
    const structureBar = structureBars[barIndex];
    const chords = (structureBar?.chords ?? []) as readonly ChordSymbol[];
    const newBar: VocalBar = { notes: {} };

    const beatKeys = Object.keys(bar.notes)
      .map((k) => ({ key: k, beat: parseFloat(k) }))
      .sort((a, b) => a.beat - b.beat);

    for (const { key, beat } of beatKeys) {
      const beatKey = BarBeatSchema.parse(key);
      const events = bar.notes[beatKey];
      if (!events) continue;
      const chord = chordAtBeat(chords, beat);
      if (!chord) {
        // No chord stream for this bar — the snap is undefined. Skip
        // gracefully; orchestrator-side schema validation surfaces the
        // missing-chord case as a typed error if it matters.
        continue;
      }

      const outEvents: VocalNoteEvent[] = [];
      for (const ev of events) {
        if (ev.type !== 'vocalNote') continue;
        const leadMidi = typeof ev.note === 'number' ? ev.note : NaN;
        if (!Number.isFinite(leadMidi)) continue;

        const shifted = leadMidi + pitchOffset;
        const snapped = findClosestChordNote(chord, shifted);
        if (snapped > maxMidi) maxMidi = snapped;

        const out: VocalNoteEvent = {
          type: 'vocalNote',
          note: MidiNoteSchema.parse(snapped),
          ...(ev.duration !== undefined && { duration: ev.duration }),
          ...(ev.fullWord !== undefined && { fullWord: ev.fullWord }),
          ...(ev.vocaloidPhonemes !== undefined && {
            vocaloidPhonemes: [...ev.vocaloidPhonemes],
          }),
          ...(ev.endOfPhrase !== undefined && { endOfPhrase: ev.endOfPhrase }),
        };
        outEvents.push(out);
      }
      if (outEvents.length > 0) newBar.notes[beatKey] = outEvents;
    }

    outBars.push(newBar);
  }
  return { bars: outBars, maxMidi };
}

function chordAtBeat(chords: readonly ChordSymbol[], beat: number): ChordSymbol | undefined {
  if (chords.length === 0) return undefined;
  const idx = Math.max(0, Math.min(chords.length - 1, Math.floor(beat)));
  return chords[idx];
}

/** Internal helper exposed for tests: returns the MIN/MAX MIDI of a
 *  segment's notes. Useful for asserting the range guard outcome. */
export function backingMidiRange(segment: VocalSegment): { min: number; max: number } | undefined {
  let min = Infinity;
  let max = -Infinity;
  for (const bar of segment.bars) {
    for (const events of Object.values(bar.notes)) {
      if (!events) continue;
      for (const ev of events) {
        if (ev.type !== 'vocalNote' || typeof ev.note !== 'number') continue;
        if (ev.note < min) min = ev.note;
        if (ev.note > max) max = ev.note;
      }
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return undefined;
  return { min, max };
}

// Re-export the range constants so the orchestrator + tests share the
// same source of truth without reaching into ./range.js.
export { MIN_NOTE, MAX_NOTE };
