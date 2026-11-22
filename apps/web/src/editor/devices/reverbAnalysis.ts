/**
 * Reading a reverb's impulse response: the energy decay curve (Schroeder's
 * backward integration), RT60 from it (T30, or T20 when the tail is short),
 * the predelay, decay times for low / mid / high bands, and a spectrogram.
 * Pure: tested on synthetic tails.
 */

import { BANDS, bandFreq, bandPowersDb } from './spectrum';

export interface ImpulseAnalysis {
  readonly durationSec: number;
  /** Seconds to fall 60 dB, or null when the tail does not fall 25 dB in the window. */
  readonly rt60Sec: number | null;
  readonly predelayMs: number;
  /** The energy decay curve in dB (0 at the start), sampled every edcStepSec. */
  readonly edcDb: Float32Array;
  readonly edcStepSec: number;
  /** RT60 per band (seconds or null): lows 125–500 Hz, mids 500 Hz–2 kHz, highs 2–8 kHz. */
  readonly bandRt: { readonly low: number | null; readonly mid: number | null; readonly high: number | null };
  /** Spectrogram frames (power dB per log band), one every hopSec. */
  readonly spectrogram: readonly Float32Array[];
  readonly hopSec: number;
}

/** RT60 from an energy decay curve in dB sampled every `step` seconds (T30, else T20). */
export function rt60FromEdc(edcDb: ArrayLike<number>, step: number): number | null {
  const firstBelow = (level: number) => {
    for (let i = 0; i < edcDb.length; i++) if (edcDb[i]! <= level) return i * step;
    return null;
  };
  const t5 = firstBelow(-5);
  if (t5 === null) return null;
  const t35 = firstBelow(-35);
  if (t35 !== null) return (t35 - t5) * 2;
  const t25 = firstBelow(-25);
  return t25 !== null ? (t25 - t5) * 3 : null;
}

/** Backward-integrated energy of a sequence of energies, in dB relative to the total. */
function schroeder(energy: ArrayLike<number>): Float32Array {
  const out = new Float32Array(energy.length);
  let acc = 0;
  for (let i = energy.length - 1; i >= 0; i--) {
    acc += energy[i]!;
    out[i] = acc;
  }
  const total = out[0] ?? 0;
  for (let i = 0; i < out.length; i++) out[i] = total > 0 && out[i]! > 0 ? 10 * Math.log10(out[i]! / total) : -200;
  return out;
}

export function analyseImpulse(left: Float32Array, right: Float32Array, sampleRate: number): ImpulseAnalysis {
  const n = left.length;
  if (right.length !== n || n === 0) throw new Error('analyseImpulse: channels must be the same, non-empty length');
  const mono = new Float32Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    mono[i] = 0.5 * (left[i]! + right[i]!);
    peak = Math.max(peak, Math.abs(mono[i]!));
  }
  if (peak === 0) throw new Error('The plugin returned silence for a click: no reverb to measure.');
  let first = 0;
  while (first < n && Math.abs(mono[first]!) < peak * 0.1) first++;

  // Energy per millisecond, then its decay curve.
  const stepFrames = Math.max(1, Math.round(sampleRate / 1000));
  const blocks = Math.ceil(n / stepFrames);
  const energy = new Float64Array(blocks);
  for (let i = 0; i < n; i++) energy[Math.floor(i / stepFrames)]! += mono[i]! * mono[i]!;
  const edcDb = schroeder(energy);
  const edcStepSec = stepFrames / sampleRate;

  // Spectrogram and per-band decay.
  const win = 2048;
  const hop = 1024;
  const frames: Float32Array[] = [];
  const bandEnergy = { low: [] as number[], mid: [] as number[], high: [] as number[] };
  const ranges = { low: [125, 500], mid: [500, 2000], high: [2000, 8000] } as const;
  for (let start = 0; start + win <= n; start += hop) {
    const p = bandPowersDb(mono.subarray(start, start + win), sampleRate);
    frames.push(p);
    for (const k of ['low', 'mid', 'high'] as const) {
      let e = 0;
      for (let b = 0; b < BANDS; b++) {
        const f = bandFreq(b);
        if (f >= ranges[k][0] && f < ranges[k][1]) e += Math.pow(10, p[b]! / 10);
      }
      bandEnergy[k].push(e);
    }
  }
  const hopSec = hop / sampleRate;
  const bandRt = {
    low: rt60FromEdc(schroeder(bandEnergy.low), hopSec),
    mid: rt60FromEdc(schroeder(bandEnergy.mid), hopSec),
    high: rt60FromEdc(schroeder(bandEnergy.high), hopSec),
  };

  return {
    durationSec: n / sampleRate,
    rt60Sec: rt60FromEdc(edcDb, edcStepSec),
    predelayMs: (first / sampleRate) * 1000,
    edcDb,
    edcStepSec,
    bandRt,
    spectrogram: frames,
    hopSec,
  };
}
