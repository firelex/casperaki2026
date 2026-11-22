import { useEffect, useMemo, useRef } from 'react';

import { livePlayer, type ProbeReading } from '../../audio/livePlayer';
import type { DeviceDef } from './deviceDefs';
import { faceplate, knob, ledMeter } from './draw';
import { BANDS, bandFreq, bandPowersDb, F_HI, F_LO } from './spectrum';

const W = 760;
const H = 330;
const HISTORY = 180; // readings (~6 s at 30 a second)

const db = (v: number) => (v > 1e-9 ? 20 * Math.log10(v) : -120);

interface Live {
  inSpec: Float32Array;
  outSpec: Float32Array;
  response: Float32Array;
  hasSpec: boolean;
  inDb: number;
  outDb: number;
  inPeakDb: number;
  outPeakDb: number;
  outHistory: number[];
  lastAt: number;
  error: string;
}

/**
 * A plugin of the mix as a device: what it is, its controls in its own
 * units, live input/output meters, and the spectrum of the signal going in
 * and coming out with the measured change between them (for an EQ, its
 * real curve). Kinds get their own view on the right: the echo pattern of
 * the delay, the pump curve of Simple Side, peaks shaved by the clipper,
 * the output's level (reverb tail) for the others. Read-only.
 */
export function DevicePanel({
  def,
  bus,
  slot,
  params,
  bpm,
}: {
  def: DeviceDef;
  bus: string;
  slot: number;
  params: readonly number[];
  bpm: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const live = useRef<Live>({
    inSpec: new Float32Array(BANDS).fill(-120),
    outSpec: new Float32Array(BANDS).fill(-120),
    response: new Float32Array(BANDS),
    hasSpec: false,
    inDb: -120,
    outDb: -120,
    inPeakDb: -120,
    outPeakDb: -120,
    outHistory: [],
    lastAt: 0,
    error: '',
  });
  const stableParams = useMemo(() => [...params], [params]);

  useEffect(() => {
    livePlayer.setProbe({ bus, slot });
    const offLevels = livePlayer.onProbe((r) => {
      const st = live.current;
      if ('error' in r) {
        st.error = r.error;
        return;
      }
      const x = r as ProbeReading;
      st.error = '';
      st.lastAt = performance.now();
      st.inDb += (db(x.inRms) - st.inDb) * 0.5;
      st.outDb += (db(x.outRms) - st.outDb) * 0.5;
      st.inPeakDb = Math.max(db(x.inPeak), st.inPeakDb - 1.2);
      st.outPeakDb = Math.max(db(x.outPeak), st.outPeakDb - 1.2);
      st.outHistory.push(db(x.outRms));
      if (st.outHistory.length > HISTORY) st.outHistory.shift();
    });
    const offRings = livePlayer.onProbeRings((r) => {
      const st = live.current;
      const sr = 44100;
      const a = bandPowersDb(r.input, sr);
      const b = bandPowersDb(r.output, sr);
      for (let i = 0; i < BANDS; i++) {
        st.inSpec[i] = st.hasSpec ? st.inSpec[i]! + (a[i]! - st.inSpec[i]!) * 0.35 : a[i]!;
        st.outSpec[i] = st.hasSpec ? st.outSpec[i]! + (b[i]! - st.outSpec[i]!) * 0.35 : b[i]!;
        // The change the plugin makes, averaged over time where there is signal.
        if (a[i]! > -110) st.response[i] = st.response[i]! + (b[i]! - a[i]! - st.response[i]!) * 0.08;
      }
      st.hasSpec = true;
    });
    return () => {
      offLevels();
      offRings();
      livePlayer.setProbe(undefined);
    };
  }, [bus, slot]);

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
      const st = live.current;
      const quiet = performance.now() - st.lastAt > 250;
      if (quiet) {
        st.inDb -= 2;
        st.outDb -= 2;
        st.inPeakDb -= 2;
        st.outPeakDb -= 2;
        for (let i = 0; i < BANDS; i++) {
          st.inSpec[i]! -= 1.5;
          st.outSpec[i]! -= 1.5;
        }
      }
      drawPanel(g, def, stableParams, st, !quiet, bpm);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [def, stableParams, bpm]);

  return <canvas ref={ref} style={{ width: W, height: H }} className="block" aria-label={`${def.title} on ${bus}: spectrum, meters and controls`} />;
}

function drawPanel(g: CanvasRenderingContext2D, def: DeviceDef, params: readonly number[], st: Live, playing: boolean, bpm: number) {
  faceplate(g, W, H);
  g.fillStyle = '#e6e7ea';
  g.font = '700 15px Archivo, system-ui, sans-serif';
  const title = def.title.toUpperCase();
  g.fillText(title, 24, 32);
  const tw = g.measureText(title).width;
  g.fillStyle = '#8f9098';
  g.font = '11px Archivo, system-ui, sans-serif';
  g.fillText(`${def.maker.toUpperCase()} · ${def.role}`, 24 + tw + 12, 32);
  if (st.error) {
    g.fillStyle = '#ff6b5e';
    g.fillText(`Probe: ${st.error}`, 24, 48);
  } else if (!playing) {
    g.fillStyle = '#8f9098';
    g.fillText('Play the song to see it work.', W - 190, 50);
  }

  spectrumView(g, 24, 58, 470, 150, st, def.kind === 'eq');
  ledMeter(g, 512, 58, 'IN', st.inDb, st.inPeakDb);
  ledMeter(g, 548, 58, 'OUT', st.outDb, st.outPeakDb);
  const ex = 590;
  const ey = 58;
  const ew = 146;
  const eh = 150;
  if (def.kind === 'delay') echoPattern(g, ex, ey, ew, eh, params);
  else if (def.kind === 'pump') pumpCurve(g, ex, ey, ew, eh, params, bpm);
  else if (def.kind === 'clipper') clipView(g, ex, ey, ew, eh, st, (params[0] ?? 0) * 18);
  else levelHistory(g, ex, ey, ew, eh, st.outHistory, def.kind === 'reverb' ? 'OUTPUT (TAIL)' : 'OUTPUT LEVEL');

  // Controls: up to 8 in one row (Simple Side's curve points are drawn, not knobs).
  const shown = def.params.slice(0, 8);
  if (shown.length === 0) {
    g.fillStyle = '#8f9098';
    g.font = '11px Archivo, system-ui, sans-serif';
    g.fillText('No controls: this stage is fixed.', 24, 270);
  }
  const step = Math.min(120, (W - 48) / Math.max(1, shown.length));
  shown.forEach((pd, i) => {
    const v = params[i] ?? 0;
    knob(g, 24 + step / 2 + i * step, 262, Math.max(0, Math.min(1, v)), pd.name.toUpperCase(), pd.display(v));
  });
}

/** Spectrum in (grey) and out (green), −100..0 dB, 20 Hz–20 kHz; the measured change (amber, ±18 dB). */
function spectrumView(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, st: Live, emphasiseResponse: boolean) {
  g.fillStyle = '#101114';
  g.fillRect(x, y, w, h);
  const fx = (f: number) => x + (Math.log(f / F_LO) / Math.log(F_HI / F_LO)) * w;
  const ly = (d: number) => y + h - ((Math.max(-100, Math.min(0, d)) + 100) / 100) * h;
  const ry = (d: number) => y + h / 2 - (Math.max(-18, Math.min(18, d)) / 18) * (h / 2 - 6);
  g.strokeStyle = 'rgba(255,255,255,0.07)';
  g.fillStyle = '#6d6e75';
  g.font = '9px Archivo, system-ui, sans-serif';
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    g.beginPath();
    g.moveTo(fx(f), y);
    g.lineTo(fx(f), y + h);
    g.stroke();
    g.fillText(f >= 1000 ? `${f / 1000}k` : String(f), fx(f) + 2, y + h - 3);
  }
  if (!st.hasSpec) return;
  // Input: filled.
  g.fillStyle = 'rgba(200,200,210,0.16)';
  g.beginPath();
  g.moveTo(x, y + h);
  for (let i = 0; i < BANDS; i++) g.lineTo(fx(bandFreq(i)), ly(st.inSpec[i]! + 10));
  g.lineTo(x + w, y + h);
  g.closePath();
  g.fill();
  // Output: line.
  g.strokeStyle = '#7dffb0';
  g.lineWidth = 1.5;
  g.beginPath();
  for (let i = 0; i < BANDS; i++) {
    const px = fx(bandFreq(i));
    const py = ly(st.outSpec[i]! + 10);
    if (i === 0) g.moveTo(px, py);
    else g.lineTo(px, py);
  }
  g.stroke();
  // The measured change (out − in).
  g.strokeStyle = emphasiseResponse ? '#ffb347' : 'rgba(255,179,71,0.55)';
  g.lineWidth = emphasiseResponse ? 2.5 : 1.2;
  g.setLineDash(emphasiseResponse ? [] : [4, 3]);
  g.beginPath();
  for (let i = 0; i < BANDS; i++) {
    const px = fx(bandFreq(i));
    const py = ry(st.response[i]!);
    if (i === 0) g.moveTo(px, py);
    else g.lineTo(px, py);
  }
  g.stroke();
  g.setLineDash([]);
  g.strokeStyle = 'rgba(255,179,71,0.25)';
  g.beginPath();
  g.moveTo(x, ry(0));
  g.lineTo(x + w, ry(0));
  g.stroke();
  g.fillStyle = '#ffb347';
  g.fillText(emphasiseResponse ? 'MEASURED CURVE (OUT − IN), ±18 dB' : 'CHANGE OUT − IN, ±18 dB', x + 4, y + 11);
  g.fillStyle = '#7dffb0';
  g.fillText('OUT', x + w - 60, y + 11);
  g.fillStyle = '#a9aab1';
  g.fillText('IN', x + w - 28, y + 11);
}

/** Output level over the last seconds (newest at the right): for reverbs, the tail. */
function levelHistory(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, hist: number[], label: string) {
  g.fillStyle = '#101114';
  g.fillRect(x, y, w, h);
  g.fillStyle = 'rgba(125,255,176,0.6)';
  hist.forEach((d, i) => {
    const bh = ((Math.max(-60, Math.min(0, d)) + 60) / 60) * h;
    g.fillRect(x + w - (hist.length - i) * (w / HISTORY), y + h - bh, Math.max(1, w / HISTORY), bh);
  });
  g.fillStyle = '#8f9098';
  g.font = '10px Archivo, system-ui, sans-serif';
  g.fillText(label, x + 3, y + 11);
}

/** The delay's repeats: one bar per echo at its time, its height the feedback after n passes. */
function echoPattern(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, params: readonly number[]) {
  const [mix = 1, , feedback = 0, sync = 0] = params;
  const beats = 0.5 + sync * 7;
  const loop = feedback * feedback * feedback; // the rebuild's loop coefficient
  g.fillStyle = '#101114';
  g.fillRect(x, y, w, h);
  const span = 8; // beats shown
  g.strokeStyle = 'rgba(255,255,255,0.08)';
  for (let b = 0; b <= span; b++) {
    g.beginPath();
    g.moveTo(x + (b / span) * w, y);
    g.lineTo(x + (b / span) * w, y + h);
    g.stroke();
  }
  g.fillStyle = '#e6e7ea';
  g.fillRect(x + 1, y + 16, 3, h - 16); // the dry note
  let level = mix;
  for (let n = 1; beats * n <= span && level > 0.01; n++) {
    const bx = x + ((beats * n) / span) * w;
    g.fillStyle = '#7dffb0';
    g.fillRect(bx - 1.5, y + h - level * (h - 16), 3, level * (h - 16));
    level *= loop;
  }
  g.fillStyle = '#8f9098';
  g.font = '10px Archivo, system-ui, sans-serif';
  g.fillText(`ECHOES · ${beats.toFixed(2)} BEATS`, x + 3, y + 11);
}

/**
 * Simple Side's pump: the gain curve over one cycle (log-shaped, as the
 * rebuild applies it) with a marker at the song's current position in the cycle.
 */
function pumpCurve(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, params: readonly number[], bpm: number) {
  const rate = Math.pow(2, params[1] ?? 0); // beats per cycle
  const pts: { x: number; y: number; e: number }[] = [];
  for (let i = 2; i + 2 < params.length; i += 3) {
    const px = params[i]!;
    const py = params[i + 1]!;
    if (i > 2 && px === 0 && py === 0) break;
    pts.push({ x: px, y: py, e: params[i + 2]! });
  }
  g.fillStyle = '#101114';
  g.fillRect(x, y, w, h);
  const env = (t: number) => {
    if (pts.length === 0) return 1;
    if (t <= pts[0]!.x) return pts[0]!.y;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      if (t <= b.x) {
        const u = b.x > a.x ? (t - a.x) / (b.x - a.x) : 1;
        const pwr = Math.pow(1.1, Math.abs(b.e));
        const shaped = b.e >= 0 ? Math.pow(u, pwr) : 1 - Math.pow(1 - u, pwr);
        return a.y + (b.y - a.y) * shaped;
      }
    }
    return pts[pts.length - 1]!.y;
  };
  const gain = (t: number) => (Math.exp(env(t)) - 1) / (Math.E - 1);
  g.strokeStyle = '#7dffb0';
  g.lineWidth = 2;
  g.beginPath();
  for (let i = 0; i <= w; i++) {
    const t = i / w;
    const py = y + 16 + (1 - gain(t)) * (h - 22);
    if (i === 0) g.moveTo(x + i, py);
    else g.lineTo(x + i, py);
  }
  g.stroke();
  const pos = livePlayer.position();
  const phase = (((pos * bpm) / 60) % rate) / rate;
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.fillRect(x + phase * w - 1, y + 14, 2, h - 14);
  g.fillStyle = '#8f9098';
  g.font = '10px Archivo, system-ui, sans-serif';
  g.fillText(`PUMP · ${rate.toFixed(2)} BEATS A CYCLE`, x + 3, y + 11);
}

/** The clipper: how many dB of peak it shaves (input peak + its boost − output peak). */
function clipView(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, st: Live, boostDb: number) {
  g.fillStyle = '#101114';
  g.fillRect(x, y, w, h);
  const shaved = st.inPeakDb > -60 ? Math.max(0, st.inPeakDb + boostDb - st.outPeakDb) : 0;
  const bh = (Math.min(6, shaved) / 6) * (h - 30);
  g.fillStyle = shaved > 0.5 ? '#ff6b5e' : '#ffd23e';
  g.fillRect(x + w / 2 - 14, y + h - 10 - bh, 28, bh);
  g.fillStyle = '#e6e7ea';
  g.font = '600 13px ui-monospace, monospace';
  g.textAlign = 'center';
  g.fillText(`${shaved.toFixed(1)} dB`, x + w / 2, y + 34);
  g.textAlign = 'left';
  g.fillStyle = '#8f9098';
  g.font = '10px Archivo, system-ui, sans-serif';
  g.fillText('PEAKS SHAVED', x + 3, y + 11);
  g.fillText(`(IN + ${boostDb.toFixed(1)} dB BOOST − OUT)`, x + 3, y + 24);
}
