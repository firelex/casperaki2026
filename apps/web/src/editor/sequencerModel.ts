/**
 * Sequencer model: a song flattened onto one timeline, for the sequencer
 * view. Sections become consecutive spans of bars; every instrument becomes
 * a track holding one clip per section it plays in, with the clip's notes
 * placed in beats from the start of the song. Pure, so it can be tested.
 */

import type { Song } from '@casperaki/song-schema';

import { sectionColor } from './sectionColor';

export const BEATS_PER_BAR = 4;

export interface SeqSection {
  readonly name: string;
  readonly kind: string;
  readonly startBar: number;
  readonly bars: number;
  readonly color: string;
  /** Chord symbols per bar (one list per bar, one entry per beat or change). */
  readonly chordsByBar: readonly (readonly string[])[];
}

export interface SeqNote {
  /** Beats from the start of the song. */
  readonly start: number;
  /** Length in beats (events without one get a short default). */
  readonly length: number;
  /** MIDI pitch, or null for events without a single pitch (chords, strums, arpeggios). */
  readonly pitch: number | null;
}

export interface SeqClip {
  readonly section: number;
  readonly startBar: number;
  readonly bars: number;
  readonly notes: readonly SeqNote[];
}

export interface SeqTrack {
  readonly name: string;
  readonly color: string;
  readonly isDrums: boolean;
  readonly clips: readonly SeqClip[];
  /** Pitch range over all notes (for vertical placement); null when no pitched notes. */
  readonly pitchRange: { readonly low: number; readonly high: number } | null;
}

export interface SequencerModel {
  readonly sections: readonly SeqSection[];
  readonly totalBars: number;
  readonly tracks: readonly SeqTrack[];
}

const NOTE_RE = /^([A-Ga-g])([#b]?)(-?\d+)$/u;
const PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** MIDI number of a note reference (number, or a name like "C#3"). */
export function noteToMidi(note: unknown): number | null {
  if (typeof note === 'number' && Number.isFinite(note)) return note;
  if (typeof note !== 'string') return null;
  const m = NOTE_RE.exec(note);
  if (!m) return null;
  let pc = PC[m[1]!.toUpperCase()]!;
  if (m[2] === '#') pc += 1;
  else if (m[2] === 'b') pc -= 1;
  return (Number.parseInt(m[3]!, 10) + 1) * 12 + pc;
}

/** Track order: rhythm section first, then harmony, melody, vocals last. */
function trackRank(name: string): number {
  const k = name.toLowerCase();
  if (k.startsWith('drum')) return 0;
  if (k.includes('perc') || k.includes('loop')) return 1;
  if (k.startsWith('bass')) return 2;
  if (k.includes('guitar')) return 3;
  if (k.startsWith('key') || k.includes('piano')) return 4;
  if (k.startsWith('pad') || k.includes('string') || k.includes('orchestr') || k.includes('brass')) return 5;
  if (k.includes('synth') || k.includes('lead') || k.includes('pluck')) return 6;
  if (k.includes('fx') || k.includes('transition')) return 8;
  if (k.includes('vocal')) return 9;
  return 7;
}

/** Same colours as the rest of the editor. */
export function trackColor(name: string): string {
  const k = name.toLowerCase();
  if (k.startsWith('drum')) return 'var(--color-c0)';
  if (k.startsWith('bass')) return 'var(--color-c1)';
  if (k.startsWith('key')) return 'var(--color-c2)';
  if (k.startsWith('pad')) return 'var(--color-c3)';
  if (k.includes('vocal')) return 'var(--color-c4)';
  return 'var(--color-c5)';
}

export function buildSequencerModel(song: Song): SequencerModel {
  const sections: SeqSection[] = [];
  let bar = 0;
  for (const seg of song.songStructure) {
    const bars = seg.lengthInBars ?? seg.bars.length;
    const kind = seg.type ?? seg.name.replace(/\d+$/u, '');
    sections.push({
      name: seg.name,
      kind,
      startBar: bar,
      bars,
      color: sectionColor(kind),
      chordsByBar: seg.bars.map((b) => b.chords.map(String)),
    });
    bar += bars;
  }

  const clipsByTrack = new Map<string, SeqClip[]>();
  sections.forEach((sec, si) => {
    const payload = song.arrangement[sec.name];
    if (!payload) return;
    for (const [instrument, override] of Object.entries(payload.overrides ?? {})) {
      const notes: SeqNote[] = [];
      (override.bars ?? []).forEach((b, barIdx) => {
        if (barIdx >= sec.bars) return;
        for (const [beatKey, events] of Object.entries(b.notes ?? {})) {
          const beat = Number.parseFloat(beatKey);
          if (!Number.isFinite(beat)) throw new Error(`${sec.name}/${instrument}: bad beat key "${beatKey}"`);
          for (const ev of (events ?? []) as Array<{ type: string; note?: unknown; duration?: number }>) {
            notes.push({
              start: (sec.startBar + barIdx) * BEATS_PER_BAR + beat,
              length: ev.duration && ev.duration > 0 ? ev.duration : ev.type === 'note' ? 0.25 : 1,
              pitch: ev.type === 'note' ? noteToMidi(ev.note) : null,
            });
          }
        }
      });
      const instrumentsOn = payload.instruments ?? {};
      if (notes.length === 0 && !instrumentsOn[instrument]) continue;
      const list = clipsByTrack.get(instrument) ?? [];
      list.push({ section: si, startBar: sec.startBar, bars: sec.bars, notes });
      clipsByTrack.set(instrument, list);
    }
  });

  const tracks: SeqTrack[] = [...clipsByTrack.entries()]
    .map(([name, clips]) => {
      const pitches = clips.flatMap((c) => c.notes.map((n) => n.pitch).filter((p): p is number => p !== null));
      return {
        name,
        color: trackColor(name),
        isDrums: name.toLowerCase().startsWith('drum'),
        clips,
        pitchRange: pitches.length ? { low: Math.min(...pitches), high: Math.max(...pitches) } : null,
      };
    })
    .sort((a, b) => trackRank(a.name) - trackRank(b.name) || a.name.localeCompare(b.name));

  return { sections, totalBars: bar, tracks };
}
