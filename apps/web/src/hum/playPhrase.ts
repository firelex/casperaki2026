// A simple phrase player for the hum editor and the melody library: the melody as a soft triangle over the chords as
// quiet sines, one chord per half bar (2 beats).

export interface PhraseNote {
  readonly beat: number;
  readonly midi: number;
  readonly duration: number;
}

export const mtof = (m: number) => 440 * 2 ** ((m - 69) / 12);

const CHORD_PCS: Record<string, number[]> = {
  '': [0, 4, 7], m: [0, 3, 7], dim: [0, 3, 6], aug: [0, 4, 8], sus4: [0, 5, 7], sus: [0, 5, 7], sus2: [0, 2, 7], '5': [0, 7], '7': [0, 4, 7, 10],
  maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10], m7b5: [0, 3, 6, 10], dim7: [0, 3, 6, 9], '6': [0, 4, 7, 9], '9': [0, 4, 7, 10, 14],
  maj9: [0, 4, 7, 11, 14], m9: [0, 3, 7, 10, 14], '11': [0, 4, 7, 10, 14, 17],
};
const ROOTS: Record<string, number> = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };

/** The notes of a chord symbol from C3 up ("sus" is the legacy banks' spelling of sus4). Throws on a symbol it cannot read. */
export function chordMidis(symbol: string): number[] {
  const m = /^([A-G][#b]?)(.*)$/u.exec(symbol);
  const pcs = m ? CHORD_PCS[m[2]!] : undefined;
  if (!m || !pcs) throw new Error(`Cannot play the chord "${symbol}"`);
  return pcs.map((i) => 48 + ROOTS[m[1]!]! + i);
}

/**
 * Plays a melody over half-bar chords; the phrase lasts `beats` (default: as long as the chords, 2 beats each; a
 * melody without chords gives its length). `onBeat` follows the position in beats; `onEnd` runs when it ends or is
 * stopped. Returns a stop function.
 */
export function playPhrase(
  melody: readonly PhraseNote[],
  chords: readonly string[],
  bpm: number,
  onEnd: () => void,
  onBeat: (beat: number) => void,
  beats: number = chords.length * 2,
): () => void {
  if (!(beats > 0)) throw new Error('playPhrase: nothing to play (no chords and no length given)');
  const voicings = chords.map(chordMidis);
  const ctx = new AudioContext();
  const spb = 60 / bpm;
  const t0 = ctx.currentTime + 0.1;
  const master = ctx.createGain();
  master.gain.value = 0.8;
  master.connect(ctx.destination);
  const tone = (midi: number, at: number, dur: number, type: OscillatorType, peak: number) => {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.value = mtof(midi);
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(peak, at + 0.015);
    g.gain.setTargetAtTime(peak * 0.6, at + 0.05, 0.2);
    g.gain.setTargetAtTime(0, at + Math.max(0.05, dur - 0.03), 0.04);
    osc.connect(g).connect(master);
    osc.start(at);
    osc.stop(at + dur + 0.3);
  };
  voicings.forEach((v, s) => v.forEach((m) => tone(m, t0 + s * 2 * spb, 2 * spb, 'sine', 0.05)));
  for (const n of melody) tone(n.midi, t0 + n.beat * spb, n.duration * spb, 'triangle', 0.22);
  const total = beats * spb + 0.6;
  let frame = 0;
  const follow = () => {
    const beat = (ctx.currentTime - t0) / spb;
    if (beat >= 0 && beat <= beats) onBeat(beat);
    frame = requestAnimationFrame(follow);
  };
  frame = requestAnimationFrame(follow);
  const timer = window.setTimeout(() => {
    cancelAnimationFrame(frame);
    void ctx.close();
    onEnd();
  }, total * 1000);
  return () => {
    cancelAnimationFrame(frame);
    window.clearTimeout(timer);
    void ctx.close();
    onEnd();
  };
}

let previewCtx: AudioContext | undefined;
/** A short tone for a note being edited. */
export function previewNote(midi: number) {
  previewCtx ??= new AudioContext();
  const ctx = previewCtx;
  const at = ctx.currentTime + 0.01;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.value = mtof(midi);
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(0.2, at + 0.01);
  g.gain.setTargetAtTime(0, at + 0.15, 0.05);
  osc.connect(g).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + 0.5);
}
