/**
 * Notes → ABC notation (https://abcnotation.com/wiki/abc:standard:v2.1), for
 * the detail view's read-only score (rendered with abcjs). Pure, so it can be
 * tested.
 *
 * What it does with the engine's notes:
 *   - quantises onsets and ends to 16ths (the engine humanises timing a little);
 *   - splits them onto a grand staff at middle C (treble ≥ C4, bass below), or
 *     one staff in the right clef when the part sits on one side;
 *   - per staff, notes that start together form a chord, held until the next
 *     onset on that staff or the chord's earliest end; gaps become rests;
 *   - splits durations into written values (whole, dotted half, half, …) and
 *     ties them, including across barlines;
 *   - spells pitches for the key (flats in flat keys) and writes accidentals
 *     only where they differ from the key signature or from an earlier
 *     accidental in the same bar.
 */

export interface ScoreNote {
  readonly pitch: number;
  /** Beats from the start of the passage. */
  readonly start: number;
  readonly length: number;
}

const STEPS_PER_BEAT = 4; // 16ths
const STEPS_PER_BAR = 16;
/** Written lengths in 16ths, longest first (whole, dotted half, half, dotted quarter, quarter, dotted 8th, 8th, 16th). */
const WRITTEN = [16, 12, 8, 6, 4, 3, 2, 1];
const SPLIT_PITCH = 60; // middle C

const SHARP_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
const FLAT_ORDER = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];
const MAJOR_FIFTHS: Record<string, number> = {
  C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, 'F#': 6, 'C#': 7, F: -1, Bb: -2, Eb: -3, Ab: -4, Db: -5, Gb: -6, Cb: -7,
  'A#': -2, 'D#': -3, 'G#': -4,
};
const MINOR_FIFTHS: Record<string, number> = {
  A: 0, E: 1, B: 2, 'F#': 3, 'C#': 4, 'G#': 5, 'D#': 6, 'A#': 7, D: -1, G: -2, C: -3, F: -4, Bb: -5, Eb: -6, Ab: -7,
  Db: -4, Gb: -5,
};

export interface KeySig {
  /** ABC K: field value ("Eb", "F#m"). */
  readonly abc: string;
  /** Sharps (> 0) or flats (< 0). */
  readonly fifths: number;
}

/** Read a song key ("C", "Am", "F#m", "Bb", "A minor", "Eb major"). */
export function parseKey(key: string): KeySig {
  const m = /^([A-Ga-g])([#b]?)\s*(m|min|minor|maj|major)?$/u.exec(key.trim());
  if (!m) throw new Error(`Unrecognised key "${key}"`);
  const tonic = m[1]!.toUpperCase() + m[2]!;
  const minor = m[3] !== undefined && m[3].startsWith('m') && !m[3].startsWith('maj');
  const fifths = (minor ? MINOR_FIFTHS : MAJOR_FIFTHS)[tonic];
  if (fifths === undefined) throw new Error(`No key signature for "${key}"`);
  // ABC has no A#/D#/G# major or Db/Gb minor key: name them by their enharmonic signature.
  return { abc: `${tonic}${minor ? 'm' : ''}`, fifths };
}

/** The accidental (-1, 0, 1) the key signature gives each letter. */
function keyAccidentals(fifths: number): Record<string, number> {
  const acc: Record<string, number> = { C: 0, D: 0, E: 0, F: 0, G: 0, A: 0, B: 0 };
  if (fifths > 0) for (const l of SHARP_ORDER.slice(0, fifths)) acc[l] = 1;
  if (fifths < 0) for (const l of FLAT_ORDER.slice(0, -fifths)) acc[l] = -1;
  return acc;
}

const SHARP_NAMES: [string, number][] = [['C', 0], ['C', 1], ['D', 0], ['D', 1], ['E', 0], ['F', 0], ['F', 1], ['G', 0], ['G', 1], ['A', 0], ['A', 1], ['B', 0]];
const FLAT_NAMES: [string, number][] = [['C', 0], ['D', -1], ['D', 0], ['E', -1], ['E', 0], ['F', 0], ['G', -1], ['G', 0], ['A', -1], ['A', 0], ['B', -1], ['B', 0]];

/** Letter, accidental and octave (C4 = 60 → octave 4) of a MIDI pitch, spelled for the key. */
function spell(pitch: number, fifths: number): { letter: string; acc: number; octave: number } {
  const pc = ((pitch % 12) + 12) % 12;
  const [letter, acc] = (fifths < 0 ? FLAT_NAMES : SHARP_NAMES)[pc]!;
  return { letter, acc, octave: Math.floor(pitch / 12) - 1 };
}

/** ABC pitch letters and octave marks: C4 = "C", C5 = "c", C6 = "c'", C3 = "C,". */
function abcLetter(letter: string, octave: number): string {
  if (octave >= 5) return letter.toLowerCase() + "'".repeat(octave - 5);
  return letter + ','.repeat(4 - octave);
}

/** Split a duration (16ths) starting at bar position `pos` into written pieces that don't cross barlines. */
function pieces(pos: number, length: number): number[] {
  const out: number[] = [];
  let p = pos;
  let left = length;
  while (left > 0) {
    const toBar = STEPS_PER_BAR - (p % STEPS_PER_BAR);
    const chunk = Math.min(left, toBar);
    // Largest written value that fits.
    let rest = chunk;
    while (rest > 0) {
      const w = WRITTEN.find((v) => v <= rest)!;
      out.push(w);
      rest -= w;
    }
    p += chunk;
    left -= chunk;
  }
  return out;
}

interface Event {
  readonly start: number; // 16ths
  readonly length: number; // 16ths
  readonly pitches: readonly number[]; // empty: rest
}

/** One staff's notes as a sequence of chords and rests covering [0, total). */
function staffEvents(notes: readonly ScoreNote[], total: number): Event[] {
  const q = notes
    .map((n) => {
      const s = Math.max(0, Math.round(n.start * STEPS_PER_BEAT));
      const e = Math.min(total, Math.max(s + 1, Math.round((n.start + n.length) * STEPS_PER_BEAT)));
      return { pitch: n.pitch, s, e };
    })
    .filter((n) => n.s < total);
  const onsets = [...new Set(q.map((n) => n.s))].sort((a, b) => a - b);
  const events: Event[] = [];
  let pos = 0;
  onsets.forEach((s, i) => {
    if (s > pos) events.push({ start: pos, length: s - pos, pitches: [] });
    const group = q.filter((n) => n.s === s);
    const next = onsets[i + 1] ?? total;
    const end = Math.min(next, ...group.map((n) => n.e));
    events.push({ start: s, length: end - s, pitches: [...new Set(group.map((n) => n.pitch))].sort((a, b) => a - b) });
    pos = end;
  });
  if (pos < total) events.push({ start: pos, length: total - pos, pitches: [] });
  return events;
}

/** One staff's measures (ABC, without barlines). Accidentals are tracked per bar (letter + octave).
 *  With `mergeRests`, runs of empty bars become one multi-bar rest measure (Z<n>). */
function staffMeasures(
  events: readonly Event[],
  fifths: number,
  marks: ReadonlyMap<number, string>,
  mergeRests: boolean,
): string[] {
  const keyAcc = keyAccidentals(fifths);
  let barAcc = new Map<string, number>();
  let out = '';
  let pos = 0;
  const pitchText = (p: number) => {
    const { letter, acc, octave } = spell(p, fifths);
    const slot = `${letter}${octave}`;
    const current = barAcc.get(slot) ?? keyAcc[letter]!;
    const mark = acc === current ? '' : acc === 1 ? '^' : acc === -1 ? '_' : '=';
    barAcc.set(slot, acc);
    return mark + abcLetter(letter, octave);
  };
  for (const ev of events) {
    // Whole empty bars become multi-bar rests (Z<n>), broken at labelled bars.
    if (ev.pitches.length === 0 && mergeRests) {
      let start = ev.start;
      let len = ev.length;
      const lead = (STEPS_PER_BAR - (start % STEPS_PER_BAR)) % STEPS_PER_BAR;
      if (lead > 0 && lead < len) {
        for (const w of pieces(start, lead)) {
          out += `z${w === 1 ? '' : w} `;
          pos += w;
        }
        start += lead;
        len -= lead;
      }
      if (start % STEPS_PER_BAR === 0 && len >= STEPS_PER_BAR) {
        let bars = Math.floor(len / STEPS_PER_BAR);
        let bar = start / STEPS_PER_BAR;
        while (bars > 0) {
          let run = 1;
          while (run < bars && !marks.has(bar + run)) run++;
          if (pos > 0) {
            out += BAR;
            barAcc = new Map();
          }
          const mark = marks.get(bar);
          if (mark) out += `"^${mark.replace(/"/gu, "'")}"`;
          out += run === 1 ? 'z16 ' : `Z${run} `;
          pos += run * STEPS_PER_BAR;
          bar += run;
          bars -= run;
        }
        const tail = len % STEPS_PER_BAR;
        if (tail === 0) continue;
        start += len - tail;
        len = tail;
      }
      if (start !== ev.start || len !== ev.length) {
        for (const w of pieces(start, len)) {
          if (pos > 0 && pos % STEPS_PER_BAR === 0) {
            out += BAR;
            barAcc = new Map();
          }
          const tailMark = pos % STEPS_PER_BAR === 0 ? marks.get(pos / STEPS_PER_BAR) : undefined;
          if (tailMark) out += `"^${tailMark.replace(/"/gu, "'")}"`;
          out += `z${w === 1 ? '' : w} `;
          pos += w;
        }
        continue;
      }
    }
    const parts = pieces(ev.start, ev.length);
    parts.forEach((len, i) => {
      if (pos > 0 && pos % STEPS_PER_BAR === 0) {
        out += BAR;
        barAcc = new Map();
      }
      const dur = len === 1 ? '' : String(len);
      // A label above the bar (e.g. the section name), on its first note or rest.
      const mark = pos % STEPS_PER_BAR === 0 ? marks.get(pos / STEPS_PER_BAR) : undefined;
      if (mark) out += `"^${mark.replace(/"/gu, "'")}"`;
      if (ev.pitches.length === 0) out += `z${dur} `;
      else {
        const body = ev.pitches.map(pitchText).join('');
        const tie = i < parts.length - 1 ? '-' : '';
        out += `${ev.pitches.length > 1 ? `[${body}]` : body}${dur}${tie} `;
      }
      pos += len;
    });
  }
  return out.split(BAR).map((m) => m.trim());
}

/** Internal barline marker while building a staff (split into measures afterwards). */
const BAR = '\u0001';
const MEASURES_PER_LINE = 4;

/** Measures as ABC lines, four a line; the last ends the piece. */
function abcLines(measures: readonly string[]): string[] {
  const lines: string[] = [];
  for (let i = 0; i < measures.length; i += MEASURES_PER_LINE) {
    const last = i + MEASURES_PER_LINE >= measures.length;
    lines.push(`${measures.slice(i, i + MEASURES_PER_LINE).join(' | ')} ${last ? '|]' : '|'}`);
  }
  return lines;
}

/** The passage as an ABC tune on a grand staff. `beats` is its length (whole bars). */
export function notesToAbc(
  notes: readonly ScoreNote[],
  opts: {
    beats: number;
    key: string;
    bpm?: number;
    /** Labels above bars (0-based bar index → text), e.g. section names. */
    marks?: ReadonlyMap<number, string>;
    /** Tune title (T:), e.g. for a printed score. */
    title?: string;
    /** Number every bar (whole-song scores). */
    barNumbers?: boolean;
  },
): string {
  const total = Math.round(opts.beats * STEPS_PER_BEAT);
  if (total <= 0 || total % STEPS_PER_BAR !== 0) throw new Error(`notesToAbc: ${opts.beats} beats is not whole bars of 4/4`);
  const key = parseKey(opts.key);
  const treble = notes.filter((n) => n.pitch >= SPLIT_PITCH);
  const bass = notes.filter((n) => n.pitch < SPLIT_PITCH);
  const marks = opts.marks ?? new Map<number, string>();
  const head = [
    'X:1',
    ...(opts.title ? [`T:${opts.title.replace(/\n/gu, ' ')}`] : []),
    'M:4/4',
    'L:1/16',
    ...(opts.barNumbers ? ['%%barnumbers 1'] : []),
    ...(opts.bpm ? [`Q:1/4=${Math.round(opts.bpm)}`] : []),
  ];
  // A part that sits on one staff gets just that staff, in its clef. Lines are
  // broken here (four measures each), not by abcjs: its line wrapping renumbers
  // bars without counting multi-bar rests.
  if (bass.length === 0 || treble.length === 0) {
    const clef = treble.length === 0 && bass.length > 0 ? 'bass' : 'treble';
    const lines = abcLines(staffMeasures(staffEvents(notes, total), key.fifths, marks, true));
    return [...head, `V:1 clef=${clef}`, `K:${key.abc}`, ...lines.map((l) => `[V:1] ${l}`)].join('\n');
  }
  // Grand staff: bar by bar on both staves (no multi-bar rests), so their lines align.
  const up = abcLines(staffMeasures(staffEvents(treble, total), key.fifths, marks, false));
  const down = abcLines(staffMeasures(staffEvents(bass, total), key.fifths, new Map(), false));
  return [
    ...head,
    '%%score {1 2}',
    'V:1 clef=treble',
    'V:2 clef=bass',
    `K:${key.abc}`,
    ...up.flatMap((l, i) => [`[V:1] ${l}`, `[V:2] ${down[i]}`]),
  ].join('\n');
}
