import { useEffect, useMemo, useRef } from 'react';

import { livePlayer, type ProbeReading } from '../../audio/livePlayer';
import { faceplate, knob, ledMeter } from './draw';

const W = 760;
const H = 300;
const GR_MAX = 20; // dB, the needle's full scale
const HISTORY_SEC = 6;
const READINGS_PER_SEC = 30;

/** Logical4's settings in its own units (Airwindows Logical4 getParameterDisplay). */
export function logical4Settings(params: readonly number[]) {
  const [a = 0, b = 0, c = 0, d = 0, e = 0] = params;
  return {
    thresholdDb: a * 40 - 20,
    ratio: b * b * 15 + 1,
    speedMs: c * c * 99 + 1,
    makeupDb: d * 40 - 20,
    dryWet: e,
  };
}

const db = (v: number) => (v > 1e-9 ? 20 * Math.log10(v) : -120);

/**
 * Logical4 (Airwindows' SSL-style bus compressor) as a device: needle meter
 * for gain reduction, the static curve with the live input level on it,
 * input / output meters, a gain-reduction history and the five controls.
 * Read-only: it shows what the engine does, measured around this plugin
 * (gain reduction = input + makeup − output, from RMS levels).
 */
export function Logical4Panel({ bus, slot, params }: { bus: string; slot: number; params: readonly number[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const s = useMemo(() => logical4Settings(params), [params]);
  // Latest measured state, smoothed with meter ballistics.
  const state = useRef({ grDb: 0, inDb: -120, outDb: -120, inPeakDb: -120, outPeakDb: -120, history: [] as number[], error: '' as string, live: false, lastAt: 0 });

  useEffect(() => {
    livePlayer.setProbe({ bus, slot });
    const off = livePlayer.onProbe((r) => {
      const st = state.current;
      if ('error' in r) {
        st.error = r.error;
        return;
      }
      st.error = '';
      st.live = true;
      st.lastAt = performance.now();
      const reading = r as ProbeReading;
      const inDb = db(reading.inRms);
      const outDb = db(reading.outRms);
      // Gain reduction from levels; silence reads as none.
      const gr = inDb > -70 ? Math.max(0, Math.min(GR_MAX + 6, inDb + s.makeupDb - outDb)) : 0;
      // Ballistics: fast attack, slower release (like a VU-ish GR meter).
      st.grDb = gr > st.grDb ? st.grDb + (gr - st.grDb) * 0.6 : st.grDb + (gr - st.grDb) * 0.18;
      st.inDb = st.inDb + (inDb - st.inDb) * 0.5;
      st.outDb = st.outDb + (outDb - st.outDb) * 0.5;
      st.inPeakDb = Math.max(db(reading.inPeak), st.inPeakDb - 1.2);
      st.outPeakDb = Math.max(db(reading.outPeak), st.outPeakDb - 1.2);
      st.history.push(gr);
      if (st.history.length > HISTORY_SEC * READINGS_PER_SEC) st.history.shift();
    });
    return () => {
      off();
      livePlayer.setProbe(undefined);
    };
  }, [bus, slot, s.makeupDb]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    const g = canvas.getContext('2d');
    if (!g) throw new Error('2D canvas is not available');
    g.scale(dpr, dpr);
    let raf = 0;
    const frame = () => {
      const st = state.current;
      // No readings for a moment (stopped or paused): let everything fall back.
      if (performance.now() - st.lastAt > 250) {
        st.live = false;
        st.grDb *= 0.85;
        st.inDb -= 2;
        st.outDb -= 2;
        st.inPeakDb -= 2;
        st.outPeakDb -= 2;
      }
      draw(g, st, s);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [s]);

  return <canvas ref={ref} style={{ width: W, height: H }} className="block" aria-label={`Logical4 on the ${bus} bus: gain reduction meter, curve and controls`} />;
}

type St = { grDb: number; inDb: number; outDb: number; inPeakDb: number; outPeakDb: number; history: number[]; error: string; live: boolean };
type Settings = ReturnType<typeof logical4Settings>;

function draw(g: CanvasRenderingContext2D, st: St, s: Settings) {
  faceplate(g, W, H);
  g.fillStyle = '#e6e7ea';
  g.font = '700 15px Archivo, system-ui, sans-serif';
  g.fillText('LOGICAL4', 24, 32);
  const titleW = g.measureText('LOGICAL4').width;
  g.fillStyle = '#8f9098';
  g.font = '11px Archivo, system-ui, sans-serif';
  g.fillText('BUS COMPRESSOR · AIRWINDOWS', 24 + titleW + 12, 32);

  gainReductionMeter(g, 24, 48, 230, 150, st.grDb, st.live);
  curve(g, 280, 48, 200, 150, s, st);
  ledMeter(g, 510, 48, 'IN', st.inDb, st.inPeakDb);
  ledMeter(g, 560, 48, 'OUT', st.outDb, st.outPeakDb);
  history(g, 610, 48, 126, 150, st.history);

  // Controls.
  const knobs: [string, number, string][] = [
    ['THRESHOLD', (s.thresholdDb + 20) / 40, `${s.thresholdDb.toFixed(1)} dB`],
    ['RATIO', Math.sqrt((s.ratio - 1) / 15), `${s.ratio.toFixed(1)}:1`],
    ['SPEED', Math.sqrt((s.speedMs - 1) / 99), `${s.speedMs.toFixed(1)} ms`],
    ['MAKEUP', (s.makeupDb + 20) / 40, `${s.makeupDb >= 0 ? '+' : ''}${s.makeupDb.toFixed(1)} dB`],
    ['DRY/WET', s.dryWet, `${Math.round(s.dryWet * 100)}%`],
  ];
  knobs.forEach(([label, v, text], i) => knob(g, 70 + i * 120, 240, v, label, text));
  if (st.error) {
    g.fillStyle = '#ff6b5e';
    g.font = '11px Archivo, system-ui, sans-serif';
    g.fillText(`Probe: ${st.error}`, W - 300, 32);
  } else if (!st.live) {
    g.fillStyle = '#8f9098';
    g.font = '11px Archivo, system-ui, sans-serif';
    g.fillText('Play the song to see it work.', W - 190, 32);
  }
}

/** Analogue needle meter, 0 to −20 dB of gain reduction (right to left, as on a bus compressor). */
function gainReductionMeter(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, grDb: number, live: boolean) {
  const face = g.createLinearGradient(x, y, x, y + h);
  face.addColorStop(0, '#f3e6c4');
  face.addColorStop(1, '#d9c99c');
  g.fillStyle = '#0d0e10';
  g.fillRect(x - 3, y - 3, w + 6, h + 6);
  g.fillStyle = face;
  g.fillRect(x, y, w, h);
  const cx = x + w / 2;
  const cy = y + h + 40;
  const r = h + 10;
  const angleOf = (dbv: number) => -Math.PI / 2 + 0.75 - (Math.min(GR_MAX, Math.max(0, dbv)) / GR_MAX) * 1.5;
  g.save();
  g.beginPath();
  g.rect(x, y, w, h);
  g.clip();
  g.strokeStyle = '#2b2416';
  g.lineWidth = 1.5;
  g.beginPath();
  g.arc(cx, cy, r - 18, angleOf(GR_MAX), angleOf(0));
  g.stroke();
  g.font = '10px Archivo, system-ui, sans-serif';
  g.fillStyle = '#2b2416';
  g.textAlign = 'center';
  for (const t of [0, 2, 4, 6, 8, 10, 14, 20]) {
    const a = angleOf(t);
    const x1 = cx + Math.cos(a) * (r - 18);
    const y1 = cy + Math.sin(a) * (r - 18);
    const x2 = cx + Math.cos(a) * (r - 28);
    const y2 = cy + Math.sin(a) * (r - 28);
    g.beginPath();
    g.moveTo(x1, y1);
    g.lineTo(x2, y2);
    g.stroke();
    g.fillText(String(t), cx + Math.cos(a) * (r - 8), cy + Math.sin(a) * (r - 8) + 3);
  }
  g.fillText('GAIN REDUCTION dB', cx, y + h - 34);
  // Needle.
  const a = angleOf(grDb);
  g.strokeStyle = '#b3241c';
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(cx, cy);
  g.lineTo(cx + Math.cos(a) * (r - 12), cy + Math.sin(a) * (r - 12));
  g.stroke();
  g.restore();
  g.textAlign = 'left';
  g.fillStyle = live ? '#ffffff' : '#8f9098';
  g.font = '600 12px ui-monospace, monospace';
  g.fillText(`−${grDb.toFixed(1)} dB`, x + 6, y + h + 18);
}

/** The static curve (input → output, before makeup) with the threshold and the live input level. */
function curve(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, s: Settings, st: St) {
  const lo = -60;
  const px = (d: number) => x + ((Math.max(lo, Math.min(0, d)) - lo) / -lo) * w;
  const py = (d: number) => y + h - ((Math.max(lo, Math.min(0, d)) - lo) / -lo) * h;
  const out = (i: number) => (i < s.thresholdDb ? i : s.thresholdDb + (i - s.thresholdDb) / s.ratio);
  g.fillStyle = '#101114';
  g.fillRect(x, y, w, h);
  g.strokeStyle = 'rgba(255,255,255,0.08)';
  g.lineWidth = 1;
  for (let d = lo; d <= 0; d += 12) {
    g.beginPath();
    g.moveTo(px(d), y);
    g.lineTo(px(d), y + h);
    g.moveTo(x, py(d));
    g.lineTo(x + w, py(d));
    g.stroke();
  }
  g.strokeStyle = 'rgba(255,255,255,0.18)';
  g.beginPath();
  g.moveTo(px(lo), py(lo));
  g.lineTo(px(0), py(0));
  g.stroke();
  g.strokeStyle = 'rgba(255,200,80,0.6)';
  g.setLineDash([3, 3]);
  g.beginPath();
  g.moveTo(px(s.thresholdDb), y);
  g.lineTo(px(s.thresholdDb), y + h);
  g.stroke();
  g.setLineDash([]);
  g.strokeStyle = '#7dffb0';
  g.lineWidth = 2;
  g.beginPath();
  for (let d = lo; d <= 0; d += 0.5) {
    if (d === lo) g.moveTo(px(d), py(out(d)));
    else g.lineTo(px(d), py(out(d)));
  }
  g.stroke();
  if (st.live && st.inDb > lo) {
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.arc(px(st.inDb), py(out(st.inDb)), 4, 0, Math.PI * 2);
    g.fill();
  }
  g.fillStyle = '#8f9098';
  g.font = '10px Archivo, system-ui, sans-serif';
  g.fillText('IN →', x + w - 26, y + h - 4);
  g.fillText('OUT', x + 3, y + 11);
  // The textbook threshold/ratio curve; Logical4 itself reacts to peaks in three stages,
  // so the measured needle can differ from where the dot sits.
  g.fillText('STATIC CURVE (NOMINAL)', x, y + h + 14);
}

/** Gain reduction over the last seconds (newest at the right). */
function history(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, hist: number[]) {
  g.fillStyle = '#101114';
  g.fillRect(x, y, w, h);
  g.strokeStyle = 'rgba(255,255,255,0.08)';
  for (const d of [3, 6, 10, 15]) {
    const yy = y + (d / GR_MAX) * h;
    g.beginPath();
    g.moveTo(x, yy);
    g.lineTo(x + w, yy);
    g.stroke();
  }
  const n = HISTORY_SEC * READINGS_PER_SEC;
  g.fillStyle = 'rgba(255,107,94,0.75)';
  hist.forEach((gr, i) => {
    const xx = x + w - (hist.length - i) * (w / n);
    g.fillRect(xx, y, Math.max(1, w / n), (Math.min(GR_MAX, gr) / GR_MAX) * h);
  });
  g.fillStyle = '#8f9098';
  g.font = '10px Archivo, system-ui, sans-serif';
  g.fillText('GR HISTORY', x + 3, y + h - 4);
}

