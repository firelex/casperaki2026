// Step 17a — vocal range envelope (first MelodyClass slice).
//
// Legacy source: casperaki2-engine-js/api/v1.0/services/classes/vocals/
// MelodyClass.js lines 29-43 (constructor range constants + _isNoteValid).
//
//     this.maxNote   = 59; // b4
//     this.minNote   = 43; // g3
//     this.medianNote = 50; // d4
//
//     _isNoteValid(note, lastNote, maxNote) {
//       return (
//         note >= this.minNote && note <= maxNote && Math.abs(note - lastNote) <= 9
//       );
//     }
//
// Constants and predicate are ported verbatim. `maxNote` is a per-call
// override because legacy `_getMergedRhythmicAndMelodicPrecedent` (line
// 1098+) sets `maxNote = 55` for several styles (e.g. Schlager). The
// override threads through the contour builder; nothing else in the slice
// uses it today, but the surface matches the legacy call shape so the
// follow-up precedent-bank port lands without re-wiring.

/** Lowest singable MIDI value (G3). Legacy: `MelodyClass.minNote`. */
export const MIN_NOTE = 43;

/** Default highest singable MIDI value (B4). Legacy: `MelodyClass.maxNote`. */
export const MAX_NOTE = 59;

/** Anchor note used as the seed when no prior note is available (D4).
 *  Legacy: `MelodyClass.medianNote`. */
export const MEDIAN_NOTE = 50;

/** Legacy `MelodyClass._isNoteValid` — in-range + adjacent-step ≤ 9 semitones.
 *
 *  `lastNote` is the previously emitted MIDI value; the first note in a
 *  sequence has no prior, so callers pass `MEDIAN_NOTE` (matching the
 *  legacy `_buildTree` initialisation which evaluates the first note
 *  against an unconstrained anchor — the only constraint there is
 *  in-range). */
export function isNoteValid(note: number, lastNote: number, maxNote: number = MAX_NOTE): boolean {
  return note >= MIN_NOTE && note <= maxNote && Math.abs(note - lastNote) <= 9;
}
