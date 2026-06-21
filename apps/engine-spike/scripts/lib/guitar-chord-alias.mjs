// docs/54v — Engine sharp-chord → disk-canonical alias.
//
// The engine's `Guitar.h::ensureSampleMidiNote:252-317` reduces every
// brain chord to a strum-pool key in SHARP form (via
// `Note::toString` → `MidiMessage::getMidiNoteName(…, useSharps=true)`).
// The Dropbox sample library mixes sharps and flats per accidental:
//
//   A#/Bb → Bb  (disk uses flat)
//   C#/Db → C#  (disk uses sharp)
//   D#/Eb → Eb  (disk uses flat)
//   F#/Gb → F#  (disk uses sharp)
//   G#/Ab → Ab  (disk uses flat)
//
// Verified by listing the chords/ subfolder of a brightPop preset.
//
// The adapter writes the brain's SHARP form into the inst's
// `virtualGuitaristSamples[]` so the engine's string-equality check
// matches. The prestage CLI translates the SHARP → DISK form ONLY for
// the file lookup; the inst entry stays in sharp form.

/** Engine sharp-root → disk-canonical root. Identity for C# and F#. */
export const ENGINE_ROOT_TO_DISK_ROOT = Object.freeze({
  'A#': 'Bb',
  'B#': 'C',
  'C#': 'C#',
  'D#': 'Eb',
  'E#': 'F',
  'F#': 'F#',
  'G#': 'Ab',
});

/** Translate a chord symbol's ROOT to disk-canonical spelling.
 *  Suffix (e.g. `9`, `m7`, `sus2`) is preserved verbatim. Returns
 *  the original symbol when no translation applies (naturals,
 *  unknown roots). */
export function engineChordToDiskChord(chord) {
  const m = String(chord).match(/^([A-G])([#b])(.*)$/u);
  if (!m) return String(chord);
  const root = `${m[1]}${m[2]}`;
  const suffix = m[3];
  const diskRoot = ENGINE_ROOT_TO_DISK_ROOT[root];
  if (!diskRoot) return String(chord);
  return `${diskRoot}${suffix}`;
}
