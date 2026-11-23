import { useEffect, useMemo, useRef, useState } from 'react';

import { livePlayer, type ProbeReading } from '../../audio/livePlayer';
import type { DeviceDef } from './deviceDefs';
import { KnobOverlay, type DeviceProControls } from './KnobOverlay';
import { faceplate, knob, ledMeter, knobRow } from './draw';
import { analyseImpulse, type ImpulseAnalysis } from './reverbAnalysis';
import { BANDS, bandFreq, F_HI, F_LO } from './spectrum';

const W = 760;
const H = 330;
const IR_SECONDS = 5;

const db = (v: number) => (v > 1e-9 ? 20 * Math.log10(v) : -120);

/**
 * A reverb as a device: its impulse response, measured by rendering a fresh
 * copy of the plugin with the mix's settings on one click (exact, offline),
 * shown as a spectrogram of the tail with the energy decay curve; RT60,
 * predelay and the decay of lows / mids / highs; live in/out meters and the
 * controls. Read-only.
 */
export function ReverbPanel({
  def,
  factory,
  bus,
  slot,
  params,
  pro,
}: {
  def: DeviceDef;
  factory: string;
  bus: string;
  slot: number;
  params: readonly number[];
  /** Pro mode: the knobs can be turned. */
  pro?: DeviceProControls | undefined;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const stableParams = useMemo(() => [...params], [params]);
  const [ir, setIr] = useState<ImpulseAnalysis | { error: string } | undefined>(undefined);
  const live = useRef({ inDb: -120, outDb: -120, inPeakDb: -120, outPeakDb: -120, lastAt: 0, error: '' });

  useEffect(() => {
    let cancelled = false;
    setIr(undefined);
    livePlayer.impulse(factory, stableParams, IR_SECONDS).then(
      (r) => !cancelled && setIr(analyseImpulse(r.left, r.right, r.sampleRate)),
      (err: unknown) => !cancelled && setIr({ error: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      cancelled = true;
    };
  }, [factory, stableParams]);

  useEffect(() => {
    livePlayer.setProbe({ bus, slot });
    const off = livePlayer.onProbe((r) => {
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
    });
    return () => {
      off();
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
    // The spectrogram is static: draw it once into an offscreen canvas.
    const spec = ir && !('error' in ir) ? spectrogramImage(ir, 430, 150) : undefined;
    let raf = 0;
    const frame = () => {
      const st = live.current;
      const playing = performance.now() - st.lastAt < 250;
      if (!playing) {
        st.inDb -= 2;
        st.outDb -= 2;
        st.inPeakDb -= 2;
        st.outPeakDb -= 2;
      }
      draw(g, def, stableParams, ir, spec, st, playing);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [def, stableParams, ir]);

  return (
    <div className="relative" style={{ width: W, height: H }}>
      <canvas ref={ref} style={{ width: W, height: H }} className="block" aria-label={`${def.title}: impulse response, decay times and controls`} />
      {pro ? <KnobOverlay knobs={knobRow(def.params.map((d) => d.name))} values={params} pro={pro} /> : null}
    </div>
  );
}

function draw(
  g: CanvasRenderingContext2D,
  def: DeviceDef,
  params: readonly number[],
  ir: ImpulseAnalysis | { error: string } | undefined,
  spec: HTMLCanvasElement | undefined,
  st: { inDb: number; outDb: number; inPeakDb: number; outPeakDb: number; error: string },
  playing: boolean,
) {
  faceplate(g, W, H);
  g.fillStyle = '#e6e7ea';
  g.font = '700 15px Archivo, system-ui, sans-serif';
  const title = def.title.toUpperCase();
  g.fillText(title, 24, 32);
  const tw = g.measureText(title).width;
  g.fillStyle = '#8f9098';
  g.font = '11px Archivo, system-ui, sans-serif';
  g.fillText(`${def.maker.toUpperCase()} · ${def.role}`, 24 + tw + 12, 32);

  const x = 24;
  const y = 58;
  const w = 430;
  const h = 150;
  g.fillStyle = '#101114';
  g.fillRect(x, y, w, h);
  if (ir === undefined) {
    g.fillStyle = '#8f9098';
    g.fillText('Measuring the impulse response…', x + 12, y + 20);
  } else if ('error' in ir) {
    g.fillStyle = '#ff6b5e';
    g.fillText(ir.error, x + 12, y + 20);
  } else {
    if (spec) g.drawImage(spec, x, y, w, h);
    // Energy decay curve: 0 dB at the top, −60 dB at the bottom.
    const tx = (t: number) => x + (t / ir.durationSec) * w;
    const dy = (d: number) => y + (Math.min(60, Math.max(0, -d)) / 60) * h;
    g.strokeStyle = '#ffffff';
    g.lineWidth = 1.8;
    g.beginPath();
    for (let i = 0; i < ir.edcDb.length; i += 4) {
      const px = tx(i * ir.edcStepSec);
      const py = dy(ir.edcDb[i]!);
      if (i === 0) g.moveTo(px, py);
      else g.lineTo(px, py);
    }
    g.stroke();
    g.setLineDash([4, 3]);
    g.strokeStyle = 'rgba(255,200,80,0.8)';
    if (ir.rt60Sec !== null && ir.rt60Sec < ir.durationSec) {
      g.beginPath();
      g.moveTo(tx(ir.rt60Sec), y);
      g.lineTo(tx(ir.rt60Sec), y + h);
      g.stroke();
    }
    g.setLineDash([]);
    g.fillStyle = '#e6e7ea';
    g.font = '10px Archivo, system-ui, sans-serif';
    g.fillText('IMPULSE RESPONSE · TAIL SPECTROGRAM + ENERGY DECAY (0 TO −60 dB)', x + 4, y + 12);
    for (let t = 1; t < ir.durationSec; t++) g.fillText(`${t}s`, tx(t) + 2, y + h - 3);

    // Readouts.
    const rx = 476;
    g.fillStyle = '#8f9098';
    g.font = '10px Archivo, system-ui, sans-serif';
    g.fillText('DECAY (RT60)', rx, y + 10);
    g.fillStyle = '#ffffff';
    g.font = '700 26px ui-monospace, monospace';
    g.fillText(ir.rt60Sec === null ? '—' : `${ir.rt60Sec.toFixed(2)} s`, rx, y + 40);
    g.fillStyle = '#8f9098';
    g.font = '10px Archivo, system-ui, sans-serif';
    g.fillText('PREDELAY', rx, y + 62);
    g.fillStyle = '#e6e7ea';
    g.font = '600 14px ui-monospace, monospace';
    g.fillText(`${ir.predelayMs.toFixed(0)} ms`, rx, y + 80);
    const bands: [string, number | null][] = [
      ['LOWS', ir.bandRt.low],
      ['MIDS', ir.bandRt.mid],
      ['HIGHS', ir.bandRt.high],
    ];
    const maxRt = Math.max(0.5, ...bands.map(([, v]) => v ?? 0));
    bands.forEach(([label, v], i) => {
      const by = y + 98 + i * 18;
      g.fillStyle = '#8f9098';
      g.font = '10px Archivo, system-ui, sans-serif';
      g.fillText(label, rx, by + 9);
      g.fillStyle = 'rgba(125,255,176,0.75)';
      g.fillRect(rx + 42, by + 1, ((v ?? 0) / maxRt) * 56, 10);
      g.fillStyle = '#e6e7ea';
      g.fillText(v === null ? '—' : `${v.toFixed(2)} s`, rx + 102, by + 9);
    });
  }

  ledMeter(g, 650, 58, 'IN', st.inDb, st.inPeakDb);
  ledMeter(g, 690, 58, 'OUT', st.outDb, st.outPeakDb);
  g.fillStyle = st.error ? '#ff6b5e' : '#8f9098';
  g.font = '11px Archivo, system-ui, sans-serif';
  if (st.error) g.fillText(`Probe: ${st.error}`, W - 300, 50);
  else if (!playing) g.fillText('Play the song for the live meters.', W - 230, 50);

  const spots = knobRow(def.params.map((d) => d.name));
  def.params.forEach((pd, i) => {
    const v = params[i] ?? 0;
    knob(g, spots[i]!.cx, spots[i]!.cy, Math.max(0, Math.min(1, v)), pd.name.toUpperCase(), pd.display(v));
  });
}

/** The tail's spectrogram as an image: time across, frequency up (log), level as colour. */
function spectrogramImage(ir: ImpulseAnalysis, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  if (!g) throw new Error('2D canvas is not available');
  const frames = ir.spectrogram;
  let max = -200;
  for (const f of frames) for (const v of f) max = Math.max(max, v);
  const img = g.createImageData(w, h);
  for (let px = 0; px < w; px++) {
    const f = frames[Math.min(frames.length - 1, Math.floor((px / w) * frames.length))];
    if (!f) continue;
    for (let py = 0; py < h; py++) {
      const freq = F_LO * Math.pow(F_HI / F_LO, 1 - py / h);
      const b = Math.max(0, Math.min(BANDS - 1, Math.round((Math.log(freq / bandFreq(0)) / Math.log(bandFreq(BANDS - 1) / bandFreq(0))) * (BANDS - 1))));
      const level = Math.max(0, Math.min(1, (f[b]! - max + 80) / 80)); // 80 dB range
      const [r, gg, bl] = heat(level);
      const o = (py * w + px) * 4;
      img.data[o] = r;
      img.data[o + 1] = gg;
      img.data[o + 2] = bl;
      img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

/** Dark blue → teal → green → yellow → white. */
function heat(v: number): [number, number, number] {
  const stops: [number, [number, number, number]][] = [
    [0, [16, 17, 20]],
    [0.35, [20, 70, 90]],
    [0.6, [40, 170, 110]],
    [0.82, [230, 220, 80]],
    [1, [255, 255, 255]],
  ];
  for (let i = 1; i < stops.length; i++) {
    const [p1, c1] = stops[i]!;
    const [p0, c0] = stops[i - 1]!;
    if (v <= p1) {
      const t = (v - p0) / (p1 - p0);
      return [0, 1, 2].map((k) => Math.round(c0[k]! + (c1[k]! - c0[k]!) * t)) as [number, number, number];
    }
  }
  return stops[stops.length - 1]![1];
}
