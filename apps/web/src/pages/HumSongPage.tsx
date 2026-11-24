import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { GENRE_TEMPO_RANGES, type Genre } from '@casperaki/song-schema/schemas';

import { HumError, humApi, type BeatNote, type HumAnalysis } from '../api/hum';
import { Score } from '../editor/sequencer/Score';
import { HumChordRow } from '../hum/HumChordRow';
import { HumPianoRoll } from '../hum/HumPianoRoll';
import {
  addNote,
  deleteNote,
  keptBars,
  moveNote,
  resizeNote,
  setChord,
  setChords,
  setMelody,
  startEdit,
  undo,
  type VersionEdit,
} from '../hum/melodyEdit';
import { AppHeader } from '../layout/AppHeader';
import { GENRE_LABELS } from '../types/genres';

/**
 * Hum a song: record a melody (with a click, or freely), see it as notes with three chord choices and, when the hum
 * is shorter than 8 bars, a completion; edit the notes and chords (piano roll, with a read-only score); listen; then
 * make a song with it as the chorus. Edits are kept per version while the page is open.
 *
 * Click mode records through an AudioWorklet in the same AudioContext as the click, so the time of beat 1 in the
 * recording is known to the sample (plus the output latency the browser reports). The hidden ?upload=1 adds an
 * upload, for testing without a microphone.
 */

type Mode = 'click' | 'free';
const BEATS_PER_BAR = 4;
const MAX_SECONDS = 40;

// ------------------------------------------------------------------ recording

const WORKLET = `
class HumRecorder extends AudioWorkletProcessor {
  constructor() { super(); this.on = true; this.port.onmessage = (e) => { if (e.data === 'stop') this.on = false; }; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && this.on) this.port.postMessage({ t: currentTime, d: ch.slice(0) });
    return this.on;
  }
}
registerProcessor('hum-recorder', HumRecorder);
`;

interface Take {
  readonly ctx: AudioContext;
  readonly stream: MediaStream;
  readonly node: AudioWorkletNode;
  readonly chunks: Float32Array[];
  /** AudioContext time of the first recorded sample. */
  firstSampleAt: number | undefined;
  /** AudioContext time of the count-in's first click (click mode). */
  readonly countInAt: number | undefined;
  readonly spb: number;
  timer: number | undefined;
}

function encodeWav(chunks: readonly Float32Array[], sampleRate: number): Blob {
  const n = chunks.reduce((s, c) => s + c.length, 0);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, n * 2, true);
  let o = 44;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++, o += 2) v.setInt16(o, Math.max(-1, Math.min(1, c[i]!)) * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

function click(ctx: AudioContext, at: number, accent: boolean) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.frequency.value = accent ? 1760 : 1100;
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(accent ? 0.5 : 0.3, at + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, at + 0.06);
  osc.connect(g).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + 0.08);
}

// ------------------------------------------------------------------ playback

const mtof = (m: number) => 440 * 2 ** ((m - 69) / 12);

const CHORD_PCS: Record<string, number[]> = {
  '': [0, 4, 7], m: [0, 3, 7], dim: [0, 3, 6], aug: [0, 4, 8], sus4: [0, 5, 7], sus2: [0, 2, 7], '5': [0, 7], '7': [0, 4, 7, 10],
  maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10], m7b5: [0, 3, 6, 10], dim7: [0, 3, 6, 9], '6': [0, 4, 7, 9], '9': [0, 4, 7, 10, 14],
  maj9: [0, 4, 7, 11, 14], m9: [0, 3, 7, 10, 14], '11': [0, 4, 7, 10, 14, 17],
};
const ROOTS: Record<string, number> = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };

function chordMidis(symbol: string): number[] {
  const m = /^([A-G][#b]?)(.*)$/u.exec(symbol);
  const pcs = m ? CHORD_PCS[m[2]!] : undefined;
  if (!m || !pcs) throw new Error(`Cannot play the chord "${symbol}"`);
  return pcs.map((i) => 48 + ROOTS[m[1]!]! + i);
}

/** Plays a melody (soft triangle) over half-bar chords (quiet sines); returns a stop function. */
function playPhrase(melody: readonly BeatNote[], chords: readonly string[], bpm: number, onEnd: () => void, onBeat: (beat: number) => void): () => void {
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
  chords.forEach((c, s) => chordMidis(c).forEach((m) => tone(m, t0 + s * 2 * spb, 2 * spb, 'sine', 0.05)));
  for (const n of melody) tone(n.midi, t0 + n.beat * spb, n.duration * spb, 'triangle', 0.22);
  const total = 8 * BEATS_PER_BAR * spb + 0.6;
  let frame = 0;
  const follow = () => {
    const beat = (ctx.currentTime - t0) / spb;
    if (beat >= 0 && beat <= 8 * BEATS_PER_BAR) onBeat(beat);
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
function previewNote(midi: number) {
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

// ------------------------------------------------------------------ page

export function HumSongPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const allowUpload = params.get('upload') === '1';
  const [mode, setMode] = useState<Mode>('click');
  const [tempo, setTempo] = useState(100);
  const [phase, setPhase] = useState<'idle' | 'countIn' | 'recording' | 'analysing' | 'done'>('idle');
  const [beatShown, setBeatShown] = useState<{ bar: number; beat: number } | undefined>(undefined);
  const [error, setError] = useState<{ step: string; message: string } | undefined>(undefined);
  const [analysis, setAnalysis] = useState<HumAnalysis | undefined>(undefined);
  const [choice, setChoice] = useState(0);
  const [genre, setGenre] = useState<Genre | undefined>(undefined);
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [playing, setPlaying] = useState(false);
  const [playBeat, setPlayBeat] = useState<number | undefined>(undefined);
  /** The user's edits, per version (undefined: as Casperaki made it). */
  const [edits, setEdits] = useState<(VersionEdit | undefined)[]>([]);
  const take = useRef<Take | undefined>(undefined);
  /** Length of a new note: the last length the user set, one beat to start with. */
  const lastLength = useRef(1);
  const stopPlay = useRef<(() => void) | undefined>(undefined);

  useEffect(() => () => {
    stopPlay.current?.();
    const t = take.current;
    if (t) {
      t.stream.getTracks().forEach((x) => x.stop());
      void t.ctx.close();
    }
  }, []);

  const fail = (err: unknown, step: string) => {
    setError(err instanceof HumError ? { step: err.step, message: err.message } : { step, message: err instanceof Error ? err.message : String(err) });
  };

  const analyse = async (audio: Blob, opts: Parameters<typeof humApi.analyse>[1]) => {
    setPhase('analysing');
    setError(undefined);
    setAnalysis(undefined);
    let a: HumAnalysis;
    try {
      a = await humApi.analyse(audio, opts);
    } catch (err) {
      fail(err, 'transcribing');
      setPhase('idle');
      return;
    }
    setAnalysis(a);
    setEdits([]);
    setChoice(0);
    setPhase('done');
    // Shorter than 8 bars: finish the melody, one version at a time (several seconds each), visibly.
    for (let i = 0; i < a.alternatives.length; i++) {
      if (a.alternatives[i]!.completed) continue;
      setBusy(`Finishing the melody: version ${i + 1} of ${a.alternatives.length}…`);
      try {
        a = await humApi.complete(a.id, i);
        setAnalysis(a);
      } catch (err) {
        fail(err, 'completing');
        break;
      }
    }
    setBusy(undefined);
  };

  const startRecording = async () => {
    setError(undefined);
    setAnalysis(undefined);
    stopPlay.current?.();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    const ctx = new AudioContext();
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'hum-recorder');
    const sink = ctx.createGain();
    sink.gain.value = 0;
    source.connect(node).connect(sink).connect(ctx.destination);
    const spb = 60 / tempo;
    const countInAt = mode === 'click' ? ctx.currentTime + 0.4 : undefined;
    const t: Take = { ctx, stream, node, chunks: [], firstSampleAt: undefined, countInAt, spb, timer: undefined };
    node.port.onmessage = (e: MessageEvent<{ t: number; d: Float32Array }>) => {
      if (t.firstSampleAt === undefined) t.firstSampleAt = e.data.t;
      t.chunks.push(e.data.d);
    };
    take.current = t;
    if (countInAt !== undefined) {
      // Schedule clicks a little ahead, for as long as the take runs.
      let next = 0;
      t.timer = window.setInterval(() => {
        while (countInAt + next * spb < ctx.currentTime + 0.25) {
          click(ctx, countInAt + next * spb, next % BEATS_PER_BAR === 0);
          next++;
        }
        const k = Math.floor((ctx.currentTime - countInAt) / spb);
        if (k >= 0) setBeatShown({ bar: Math.floor(k / BEATS_PER_BAR), beat: (k % BEATS_PER_BAR) + 1 });
        setPhase(k < BEATS_PER_BAR ? 'countIn' : 'recording');
        if (ctx.currentTime - countInAt > MAX_SECONDS) stopRecording();
      }, 25);
      setPhase('countIn');
    } else {
      const startedAt = ctx.currentTime;
      t.timer = window.setInterval(() => {
        if (ctx.currentTime - startedAt > MAX_SECONDS) stopRecording();
      }, 200);
      setPhase('recording');
    }
  };

  const stopRecording = () => {
    const t = take.current;
    if (!t) return;
    take.current = undefined;
    window.clearInterval(t.timer);
    t.node.port.postMessage('stop');
    t.stream.getTracks().forEach((x) => x.stop());
    setBeatShown(undefined);
    if (t.firstSampleAt === undefined || t.chunks.length === 0) {
      void t.ctx.close();
      setPhase('idle');
      setError({ step: 'recording', message: 'Nothing was recorded. Check that the browser may use the microphone.' });
      return;
    }
    const audio = encodeWav(t.chunks, t.ctx.sampleRate);
    // When beat 1 (the first click after the count-in) is heard, in the recording's time.
    const latency = t.ctx.outputLatency || t.ctx.baseLatency || 0;
    const firstBeatSec = t.countInAt !== undefined ? t.countInAt + BEATS_PER_BAR * t.spb + latency - t.firstSampleAt : undefined;
    void t.ctx.close();
    if (mode === 'click') {
      if (firstBeatSec === undefined) throw new Error('click mode without a count-in time');
      void analyse(audio, { mode: 'click', bpm: tempo, firstBeatSec });
    } else void analyse(audio, { mode: 'free' });
  };

  const alt = analysis?.alternatives[choice];
  const edited = edits[choice];
  const cur = useMemo(() => edited ?? (alt ? startEdit(alt.melody, alt.chords) : undefined), [edited, alt]);
  const change = (next: VersionEdit) => {
    if (next === cur) return;
    setEdits((all) => {
      const copy = [...all];
      copy[choice] = next;
      return copy;
    });
  };
  const scoreNotes = useMemo(() => (cur ? cur.melody.map((n) => ({ pitch: n.midi, start: n.beat, length: n.duration })) : []), [cur]);
  const scoreChords = useMemo(() => {
    const m = new Map<number, string>();
    cur?.chords.forEach((c, s) => {
      if (s === 0 || c !== cur.chords[s - 1]) m.set(s * 8, c);
    });
    return m;
  }, [cur]);
  const keep = cur && analysis ? keptBars(cur, analysis.hummedBars) : [];

  // Ctrl+Z (Cmd+Z) undoes the last edit of this version.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'z' || !(e.ctrlKey || e.metaKey) || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (t && ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
      if (!edited || edited.history.length === 0) return;
      e.preventDefault();
      change(undo(edited));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  const styles = useMemo(() => {
    const bpm = analysis?.bpm;
    return (Object.keys(GENRE_LABELS) as Genre[]).map((g) => {
      const r = GENRE_TEMPO_RANGES[g];
      return { genre: g, label: GENRE_LABELS[g], ok: bpm !== undefined && bpm >= r.min && bpm <= r.max, range: `${r.min}–${r.max}` };
    });
  }, [analysis?.bpm]);
  useEffect(() => {
    if (!genre || !styles.find((s) => s.genre === genre)?.ok) setGenre(styles.find((s) => s.ok)?.genre);
  }, [styles, genre]);

  const togglePlay = () => {
    if (playing) {
      stopPlay.current?.();
      return;
    }
    if (!cur || !analysis) return;
    setPlaying(true);
    try {
      stopPlay.current = playPhrase(
        cur.melody,
        cur.chords,
        analysis.bpm,
        () => {
          setPlaying(false);
          setPlayBeat(undefined);
          stopPlay.current = undefined;
        },
        setPlayBeat,
      );
    } catch (err) {
      setPlaying(false);
      fail(err, 'playing');
    }
  };

  const reComplete = async () => {
    if (!analysis || !cur) return;
    stopPlay.current?.();
    setBusy(`Finishing the melody of version ${choice + 1} a different way…`);
    setError(undefined);
    try {
      if (!edited) setAnalysis(await humApi.complete(analysis.id, choice));
      else {
        // Edited: only the bars that are neither hummed nor edited are rewritten, over the chords as they are now.
        const i = choice;
        const done = await humApi.complete(analysis.id, i, { melody: cur.melody, chords: cur.chords, keepBars: keep });
        setEdits((all) => {
          const copy = [...all];
          copy[i] = setMelody(cur, done.alternatives[i]!.melody);
          return copy;
        });
      }
    } catch (err) {
      fail(err, 'completing');
    } finally {
      setBusy(undefined);
    }
  };

  const makeSong = async () => {
    if (!analysis || !genre) return;
    stopPlay.current?.();
    setBusy('Making the song…');
    setError(undefined);
    try {
      const { songId } = await humApi.song(analysis.id, choice, genre, edited ? { melody: edited.melody, chords: edited.chords } : undefined);
      navigate(`/editor/${songId}/timeline`);
    } catch (err) {
      fail(err, 'building the song');
      setBusy(undefined);
    }
  };

  const refit = async () => {
    if (!analysis || !cur) return;
    setBusy('Fitting chords to your melody…');
    setError(undefined);
    try {
      change(setChords(cur, await humApi.refit(analysis.id, cur.melody)));
    } catch (err) {
      fail(err, 'chords');
    } finally {
      setBusy(undefined);
    }
  };

  const recording = phase === 'countIn' || phase === 'recording';

  return (
    <div className="min-h-screen w-full bg-bg text-fg">
      <AppHeader />
      <main className="mx-auto w-full max-w-[1000px] px-4 pb-24 pt-10 sm:px-8 sm:pt-14">
        <h1 className="app-heading text-[30px] leading-tight text-white sm:text-[36px]">Hum a song</h1>
        <p className="mt-2 max-w-[70ch] text-[15px] leading-relaxed text-white/60">
          Hum or sing a melody of up to 8 bars. Casperaki turns it into notes, finds chords for it, finishes the melody if it is shorter than 8 bars, and builds a song
          with it as the chorus.
        </p>

        <section className="mt-8 rounded-[14px] border border-line bg-white/[0.03] p-5" aria-label="Recording">
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex rounded-full border border-line p-0.5" role="radiogroup" aria-label="Recording mode">
              {(['click', 'free'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={mode === m}
                  disabled={recording}
                  onClick={() => setMode(m)}
                  className={`h-8 rounded-full px-4 text-[14px] ${mode === m ? 'bg-white text-black' : 'text-white/70 hover:text-white'}`}
                >
                  {m === 'click' ? 'With a click' : 'Free'}
                </button>
              ))}
            </div>
            {mode === 'click' ? (
              <label className="flex items-center gap-2 text-[14px] text-white/70">
                Tempo
                <input
                  type="number"
                  min={60}
                  max={150}
                  value={tempo}
                  disabled={recording}
                  onChange={(e) => setTempo(Math.max(60, Math.min(150, Math.round(Number(e.target.value) || 100))))}
                  className="h-9 w-20 rounded-[8px] border border-line bg-transparent px-2 text-white"
                />
                bpm
              </label>
            ) : null}
            {recording ? (
              <button type="button" onClick={stopRecording} className="h-10 rounded-full bg-red-500 px-5 text-[14px] font-semibold text-white">
                ● Stop
              </button>
            ) : (
              <button
                type="button"
                disabled={phase === 'analysing'}
                onClick={() => void startRecording().catch((e: unknown) => (fail(e, 'recording'), setPhase('idle')))}
                className="h-10 rounded-full bg-accent px-5 text-[14px] font-semibold text-white hover:bg-[#e00000] disabled:opacity-40"
              >
                {analysis ? 'Retry' : 'Record'}
              </button>
            )}
            {allowUpload ? (
              <label className="h-10 cursor-pointer rounded-full border border-line px-5 text-[14px] leading-10 text-white/80 hover:border-white/40">
                Upload a file instead
                <input
                  type="file"
                  accept="audio/*"
                  className="sr-only"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (f) void analyse(f, mode === 'click' ? { mode: 'click', bpm: tempo, firstBeatSec: 0 } : { mode: 'free' });
                  }}
                />
              </label>
            ) : null}
          </div>
          {mode === 'click' ? (
            <p className="mt-3 text-[13px] text-white/50">
              You will hear one bar of clicks, then hum along with the click from beat 1. Use headphones, so the click is not recorded.
            </p>
          ) : (
            <p className="mt-3 text-[13px] text-white/50">Hum freely; the tempo and the bars are found afterwards. If they come out wrong, retry or use the click.</p>
          )}
          {recording ? (
            <div className="mt-6 flex items-center gap-6" aria-live="polite">
              {mode === 'click' ? (
                <div className="flex gap-3">
                  {[1, 2, 3, 4].map((b) => (
                    <span
                      key={b}
                      className={`flex h-16 w-16 items-center justify-center rounded-full text-[28px] font-bold transition-colors ${
                        beatShown?.beat === b ? (b === 1 ? 'bg-accent text-white' : 'bg-white text-black') : 'bg-white/10 text-white/40'
                      }`}
                    >
                      {b}
                    </span>
                  ))}
                </div>
              ) : null}
              <span className="text-[15px] text-white/70">
                {phase === 'countIn' ? 'Count-in… start on the next 1' : mode === 'click' && beatShown ? `Recording: bar ${beatShown.bar}` : 'Recording…'}
              </span>
            </div>
          ) : null}
          {phase === 'analysing' ? <p className="mt-6 text-[15px] text-white/70" role="status">Listening to your hum and finding chords…</p> : null}
          {error ? (
            <p className="mt-4 rounded-[8px] bg-red-500/10 px-3 py-2 text-[14px] text-red-200" role="alert">
              <span className="font-semibold">Failed while {error.step}:</span> {error.message}
            </p>
          ) : null}
        </section>

        {analysis && alt && cur ? (
          <section className="mt-6 rounded-[14px] border border-line bg-white/[0.03] p-5" aria-label="Your melody">
            <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-[14px] text-white/70">
              <span>
                <span className="text-white">{analysis.bpm}</span> bpm
              </span>
              <span>
                Key <span className="text-white">{analysis.songKey}</span>
              </span>
              <span>
                Hummed {analysis.hummedBars} of 8 bars · {analysis.hum.notesKept} notes
                {analysis.hum.pickupDropped ? ` (a ${analysis.hum.pickupDropped}-note lead-in left out)` : ''}
              </span>
            </div>
            <div className="mt-4 flex flex-wrap gap-2" role="tablist" aria-label="Chord choices">
              {analysis.alternatives.map((a, i) => (
                <button
                  key={i}
                  type="button"
                  role="tab"
                  aria-selected={choice === i}
                  onClick={() => (stopPlay.current?.(), setChoice(i))}
                  className={`h-8 rounded-full px-3 text-[13px] ${choice === i ? 'bg-white/15 text-white' : 'text-white/55 hover:text-white'}`}
                  title={a.label}
                >
                  {`Version ${i + 1}`}
                </button>
              ))}
            </div>
            <div className="mt-4">
              <HumChordRow
                chords={cur.chords}
                onPick={(slot, chord) => change(setChord(cur, slot, chord))}
                loadOptions={(slot) => humApi.chordOptions(analysis.id, cur.melody, slot)}
              />
              <HumPianoRoll
                key={`${analysis.id}-${choice}`}
                melody={cur.melody}
                hummedBars={analysis.hummedBars}
                editedBars={cur.editedBars}
                playBeat={playBeat}
                onAdd={(beat, midi) => {
                  const next = addNote(cur, beat, midi, lastLength.current);
                  if (next !== cur) previewNote(midi);
                  change(next);
                }}
                onDelete={(i) => change(deleteNote(cur, i))}
                onMove={(i, beat, midi) => change(moveNote(cur, i, beat, midi))}
                onResize={(i, length) => {
                  const next = resizeNote(cur, i, length);
                  if (next !== cur) {
                    previewNote(cur.melody[i]!.midi);
                    lastLength.current = next.melody.find((n) => n.beat === cur.melody[i]!.beat)!.duration;
                  }
                  change(next);
                }}
                onPitch={previewNote}
              />
              <p className="mt-2 text-[12px] text-white/45">
                Click to add a note · right click to delete · drag to move · hold, then drag to change the length · Ctrl+Z to undo. Red: hummed · blue:
                completed · amber: changed by you. Click a chord to change it.
              </p>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button type="button" onClick={togglePlay} className="h-10 rounded-full bg-white px-5 text-[14px] font-semibold text-black">
                {playing ? '■ Stop' : '▶ Play'}
              </button>
              {analysis.hummedBars < 8 ? (
                <button
                  type="button"
                  onClick={() => void reComplete()}
                  disabled={Boolean(busy) || !alt.completed || keep.length >= 8 || cur.melody.length === 0}
                  title={keep.length >= 8 ? 'Every bar is hummed or changed by you; there is nothing left to complete.' : 'Rewrite the bars you did not hum or change'}
                  className="h-10 rounded-full border border-line px-5 text-[14px] text-white/80 hover:border-white/40 disabled:opacity-40"
                >
                  Complete a different way
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => void refit()}
                disabled={Boolean(busy) || cur.melody.length === 0}
                className="h-10 rounded-full border border-line px-5 text-[14px] text-white/80 hover:border-white/40 disabled:opacity-40"
              >
                Re-fit chords
              </button>
              <button
                type="button"
                onClick={() => edited && change(undo(edited))}
                disabled={!edited || edited.history.length === 0}
                className="h-10 rounded-full border border-line px-4 text-[14px] text-white/80 hover:border-white/40 disabled:opacity-40"
              >
                Undo
              </button>
              <button
                type="button"
                onClick={() =>
                  setEdits((all) => {
                    const copy = [...all];
                    copy[choice] = undefined;
                    return copy;
                  })
                }
                disabled={!edited}
                className="h-10 rounded-full border border-line px-4 text-[14px] text-white/80 hover:border-white/40 disabled:opacity-40"
              >
                Back to the original
              </button>
              {busy ? (
                <span className="text-[14px] text-white/70" role="status">
                  {busy}
                </span>
              ) : null}
            </div>
            <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-line/60 pt-5">
              <label className="flex items-center gap-2 text-[14px] text-white/70">
                Style
                <select value={genre ?? ''} onChange={(e) => setGenre(e.target.value as Genre)} className="h-10 rounded-[8px] border border-line bg-bg px-2 text-white">
                  {styles.map((s) => (
                    <option key={s.genre} value={s.genre} disabled={!s.ok}>
                      {s.ok ? s.label : `${s.label} (needs ${s.range} bpm)`}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                onClick={() => void makeSong()}
                disabled={!genre || Boolean(busy) || !alt.completed || cur.melody.length === 0}
                className="h-10 rounded-full bg-accent px-5 text-[14px] font-semibold text-white hover:bg-[#e00000] disabled:opacity-40"
              >
                Make the song
              </button>
              {cur.melody.length === 0 ? <span className="text-[13px] text-white/50">The melody has no notes: add some, or go back to the original.</span> : null}
              {!styles.some((s) => s.ok) ? <span className="text-[13px] text-white/50">No style takes {analysis.bpm} bpm: retry with the click at another tempo.</span> : null}
            </div>
            <div className="mt-6 border-t border-line/60 pt-3">
              <h2 className="px-4 text-[14px] font-semibold text-white/80">Score</h2>
              <Score
                notes={scoreNotes}
                beats={8 * BEATS_PER_BAR}
                songKey={analysis.songKey}
                bpm={analysis.bpm}
                beat={playBeat}
                chords={scoreChords}
                caption="Your melody and chords, rounded to 16ths. It follows every change in the piano roll."
              />
            </div>
          </section>
        ) : null}
      </main>
    </div>
  );
}
