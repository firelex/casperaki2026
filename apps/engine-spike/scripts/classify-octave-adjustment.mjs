#!/usr/bin/env node
// docs/58b — Port of casperaki1/calculateOctaveAdjustmentsAndSaveToDatabase.js
// (the octave-detect half only — its LUFS half always overwrites the
// measured value with the constant '-24.0' before persisting and is not
// worth porting).
//
// For each tonal inst-N.json in a render directory, find the slot whose
// `note` is closest to `c3`, decode the staged `vstsample-<id>.ogg`,
// run an FFT on the first ~1 second of audio after a silence trim, find
// the dominant peak frequency, and vote per the legacy table:
//
//   |peak| <= 23 Hz         → +3   (sample is 3 octaves below C3 → C0)
//   23  < |peak| <= 46      → +2   (C1)
//   46  < |peak| <= 66      → +1   (C2)
//   129 <= |peak| <= 132    →  0   (C3 — correct)
//   260 <= |peak| <= 263    → -1   (C4)
//   522 <= |peak| <= 525    → -2   (C5)
//   1045<= |peak| <= 1048   → -3   (C6)
//   2091<= |peak| <= 2095   → -4   (C7)
//   else                    →  0   (legacy: 'Unknown' → 0)
//
// Writes a JSON map keyed by `inst-N.json` filename → adjustment:
//
//   {
//     "schemaVersion": 1,
//     "renderDir": "...",
//     "entries": {
//       "inst-2.json": { name: "Bass",    lowLevelType: "...", slotId: ..., slotNote: "c3", peakHz: 261.7, adjustment: -1 },
//       "inst-3.json": { name: "Keys",    ... },
//       ...
//     }
//   }
//
// Usage:
//   node scripts/classify-octave-adjustment.mjs <renderDir> [--out <path>]
//
// `renderDir` must contain inst-N.json files; their referenced samples
// are looked up under ~/.config/CasperakiSpike/Temporary/vstsample-<id>.ogg.
//
// NO catalog/adapter writes — that's 58c's job.

import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMP_DIR = join(homedir(), '.config', 'CasperakiSpike', 'Temporary');
const SR = 44100;

// pYIN helper — same algorithm the legacy script used
// (sonic-annotator vamp:pyin:yin:f0), via librosa.pyin from one of the
// model services' venvs. When the helper is unavailable the classifier
// falls back to its in-process FFT+HPS detector below.
const PYIN_SCRIPT = resolve(__dirname, 'lib', 'pyin_pitch.py');
const PYIN_PY_CANDIDATES = [
  resolve(__dirname, '../../models/services/sam-audio/.venv/bin/python'),
  resolve(__dirname, '../../models/services/soulx-singer/.venv/bin/python'),
];
const PYIN_PY = PYIN_PY_CANDIDATES.find((p) => existsSync(p));

/**
 * Batch-classify a list of audio paths via librosa.pyin. Returns
 * Map<path, { f0Hz: number|null, voicedFraction: number, error?: string }>.
 * Returns an empty Map (and logs a warning) when no venv with librosa
 * was discoverable.
 */
function pyinBatch(paths) {
  const out = new Map();
  if (paths.length === 0) return out;
  if (!PYIN_PY) {
    console.error('[classify-octave] WARN: no librosa venv found, falling back to FFT+HPS');
    return out;
  }
  const r = spawnSync(PYIN_PY, [PYIN_SCRIPT, ...paths], {
    maxBuffer: 1024 * 1024 * 64,
  });
  if (r.status !== 0) {
    console.error(`[classify-octave] WARN: pyin helper failed: ${r.stderr?.toString() ?? ''}`);
    return out;
  }
  for (const line of r.stdout.toString().split('\n')) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      out.set(j.path, j);
    } catch { /* ignore */ }
  }
  return out;
}

// docs/54z, 53w — tonal families whose inst-N.json carries a multisample
// grid worth classifying. Drum kits are per-sub-instrument and not
// transposable via octaveAdjustment; transitions / loops / fx are
// untyped or pre-rendered.
const TONAL_TYPES = new Set([
  'basses',
  'keys',
  'synths',
  'leadSynths',
  'acousticGuitars',
  'electricGuitars',
  'popBrass',
  'popStrings',
  'orchestral',
  'vocals',
]);

// MIDI note name → MIDI number. Mirrors the engine's getMidiNoteNumber
// convention (a4 = 69, c3 = 48).
const NOTE_NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];
function midiFromNoteName(n) {
  const m = /^([a-g]#?)(-?\d+)$/u.exec(n.toLowerCase());
  if (!m) throw new Error(`bad note: ${n}`);
  const semitone = NOTE_NAMES.indexOf(m[1]);
  if (semitone < 0) throw new Error(`bad pitch class: ${m[1]}`);
  const oct = Number.parseInt(m[2], 10);
  // C3 = MIDI 48 (engine convention).
  return semitone + (oct + 1) * 12;
}
function hzFromMidi(m) { return 440 * Math.pow(2, (m - 69) / 12); }

// Legacy bin table — see comment block at top.
function classifyByLegacyBins(peakHz) {
  const a = Math.abs(peakHz);
  if (a <= 23) return 3;
  if (a > 23 && a <= 46) return 2;
  if (a > 46 && a <= 66) return 1;
  if (a >= 129 && a <= 132) return 0;
  if (a >= 260 && a <= 263) return -1;
  if (a >= 522 && a <= 525) return -2;
  if (a >= 1045 && a <= 1048) return -3;
  if (a >= 2091 && a <= 2095) return -4;
  return null; // 'Unknown' in legacy → caller's fallback
}

// Generalised classifier: given the slot's expected fundamental and the
// detected peak, return the nearest octave offset (log2 rounded). The
// legacy fixed the slot at c3 (~130.8 Hz); ours can run on any slot
// note. Returns null when the ratio is too far from an octave boundary
// to be a real octave error (e.g. the sample is detuned by a fifth, a
// third, etc. — not our job to "fix" that). The legacy implicitly did
// this via its narrow ±2 Hz bins around the C0..C7 frequencies; we use
// an explicit log2 tolerance instead.
const RATIO_TOLERANCE_OCTAVES = 0.25;
function classifyByOctaveRatio(peakHz, expectedHz) {
  if (peakHz <= 0 || expectedHz <= 0) return null;
  const ratio = peakHz / expectedHz;
  const octaves = Math.log2(ratio);
  const rounded = Math.round(octaves);
  if (Math.abs(octaves - rounded) > RATIO_TOLERANCE_OCTAVES) return null;
  // -rounded because: if peak is one octave above expected, the sample
  // is recorded too high → engine compensates DOWN by 1 octave →
  // adjustment = -1. Matches legacy sign convention.
  const adj = -rounded;
  if (Math.abs(adj) > 4) return null;
  return adj;
}

function decodeOggToFloat32(oggPath) {
  // ffmpeg → mono, 44.1 kHz, signed-16 PCM little-endian on stdout.
  const r = spawnSync(
    'ffmpeg',
    [
      '-hide_banner', '-loglevel', 'error',
      '-i', oggPath,
      '-ac', '1', '-ar', String(SR), '-f', 's16le',
      'pipe:1',
    ],
    { maxBuffer: 1024 * 1024 * 1024 },
  );
  if (r.status !== 0) {
    throw new Error(`ffmpeg decode failed for ${oggPath}: ${r.stderr?.toString() ?? ''}`);
  }
  const pcm = r.stdout;
  const n = pcm.length / 2;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const lo = pcm[2 * i];
    const hi = pcm[2 * i + 1];
    let s = lo | (hi << 8);
    if (s & 0x8000) s |= ~0xffff;
    out[i] = s / 32768;
  }
  return out;
}

// Trim leading silence below a noise floor (-50 dBFS) then return up to
// `windowSec` of audio starting from the first non-silent sample.
function trimAndWindow(samples, windowSec) {
  const FLOOR = Math.pow(10, -50 / 20);
  let start = 0;
  for (; start < samples.length; start++) {
    if (Math.abs(samples[start]) > FLOOR) break;
  }
  const lenFrames = Math.min(Math.floor(windowSec * SR), samples.length - start);
  if (lenFrames <= 0) return new Float32Array(0);
  return samples.slice(start, start + lenFrames);
}

// Naive radix-2 Cooley-Tukey, in-place on interleaved (re, im) Float64.
// Input length must be a power of 2.
function fftRadix2(re, im) {
  const n = re.length;
  if ((n & (n - 1)) !== 0) throw new Error('fft length must be a power of 2');
  // bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const ang = (-2 * Math.PI) / size;
    const wReStep = Math.cos(ang);
    const wImStep = Math.sin(ang);
    for (let i = 0; i < n; i += size) {
      let wRe = 1, wIm = 0;
      for (let k = 0; k < half; k++) {
        const tRe = wRe * re[i + k + half] - wIm * im[i + k + half];
        const tIm = wRe * im[i + k + half] + wIm * re[i + k + half];
        re[i + k + half] = re[i + k] - tRe;
        im[i + k + half] = im[i + k] - tIm;
        re[i + k] += tRe;
        im[i + k] += tIm;
        const nRe = wRe * wReStep - wIm * wImStep;
        const nIm = wRe * wImStep + wIm * wReStep;
        wRe = nRe; wIm = nIm;
      }
    }
  }
}

// Hann-windowed FFT → return the *fundamental* peak frequency in Hz,
// restricted to 20 Hz..4 kHz. Uses Harmonic Product Spectrum (HPS) to
// resolve bright-timbre cases where a higher harmonic outweighs the
// fundamental (e.g. Synths c3 slot whose 10th partial dominates the
// raw spectrum). Bin-quadratic refinement nudges the result to sub-bin
// accuracy.
function dominantPeakHz(samples) {
  let n = 1;
  while ((n << 1) <= samples.length) n <<= 1;
  if (n < 1024) return 0;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    re[i] = samples[i] * w;
  }
  fftRadix2(re, im);
  const half = n >> 1;
  const binHz = SR / n;
  const lo = Math.max(1, Math.floor(20 / binHz));
  const hi = Math.min(half - 1, Math.ceil(4000 / binHz));

  // Magnitudes (squared is fine for argmax / product).
  const mag = new Float64Array(half);
  for (let k = 0; k < half; k++) mag[k] = re[k] * re[k] + im[k] * im[k];

  // HPS: for each candidate fundamental bin f, score = product of
  // magnitudes at f, 2f, 3f, 4f, 5f (downsample-multiply trick).
  // Maxes at the bin where the largest set of harmonics line up,
  // which is the fundamental even when a single higher partial
  // (e.g. the 10th) is the loudest single bin.
  const HARMONICS = 5;
  const hpsHi = Math.min(hi, Math.floor((half - 1) / HARMONICS));
  let bestBin = lo, bestScore = -Infinity;
  for (let k = lo; k <= hpsHi; k++) {
    let score = 0;
    for (let h = 1; h <= HARMONICS; h++) {
      score += Math.log(mag[k * h] + 1e-30);
    }
    if (score > bestScore) { bestScore = score; bestBin = k; }
  }

  // Parabolic interpolation around the chosen HPS bin (on log-mag of
  // the raw spectrum so the refinement targets the actual peak shape).
  const ym1 = Math.log(mag[bestBin - 1] + 1e-30);
  const y0  = Math.log(mag[bestBin] + 1e-30);
  const yp1 = Math.log(mag[bestBin + 1] + 1e-30);
  const denom = ym1 - 2 * y0 + yp1;
  const shift = denom === 0 ? 0 : 0.5 * (ym1 - yp1) / denom;
  return (bestBin + shift) * binHz;
}

function pickClassifierSlot(inst) {
  // Prefer slot with note === 'c3' (legacy). Otherwise the slot whose
  // note is nearest C3 (MIDI 48). Returns null if no `samples` array.
  if (!Array.isArray(inst.samples) || inst.samples.length === 0) return null;
  let best = null, bestDist = Infinity;
  for (const slot of inst.samples) {
    if (!slot.note || typeof slot.note !== 'string') continue;
    try {
      const midi = midiFromNoteName(slot.note);
      const dist = Math.abs(midi - 48);
      if (dist < bestDist) { best = slot; bestDist = dist; }
    } catch { /* ignore non-pitched slots */ }
  }
  return best;
}

// --- main ---

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('usage: classify-octave-adjustment.mjs <renderDir> [--out <path>]');
  process.exit(2);
}
const renderDir = resolve(args[0]);
let outPath = resolve(renderDir, 'octave-adjustment-map.json');
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--out' && i + 1 < args.length) outPath = resolve(args[++i]);
}
if (!existsSync(renderDir)) {
  console.error(`renderDir does not exist: ${renderDir}`);
  process.exit(2);
}

const files = readdirSync(renderDir)
  .filter((f) => /^inst-\d+\.json$/u.test(f))
  .sort();
if (files.length === 0) {
  console.error(`no inst-N.json found under ${renderDir}`);
  process.exit(2);
}

// First pass: collect every tonal slot's ogg path so we can batch
// pyin_pitch.py in a single subprocess (librosa+numpy import is the
// dominant cost; one process amortises it across all instruments).
const instData = [];
for (const file of files) {
  const inst = JSON.parse(readFileSync(join(renderDir, file), 'utf-8'));
  instData.push({ file, inst });
}
const oggPaths = [];
for (const { inst } of instData) {
  if (!TONAL_TYPES.has(inst.type)) continue;
  const slot = pickClassifierSlot(inst);
  if (!slot) continue;
  const ogg = join(TEMP_DIR, `vstsample-${slot.id}.ogg`);
  if (existsSync(ogg)) oggPaths.push(ogg);
}
const pyinResults = pyinBatch(oggPaths);

const entries = {};
let classified = 0, skipped = 0;
for (const { file, inst } of instData) {
  const type = inst.type;
  if (!TONAL_TYPES.has(type)) {
    entries[file] = { name: inst.name, type, skipReason: 'non-tonal' };
    skipped++;
    continue;
  }
  const slot = pickClassifierSlot(inst);
  if (!slot) {
    entries[file] = { name: inst.name, type, skipReason: 'no-multisample-slot' };
    skipped++;
    continue;
  }
  const ogg = join(TEMP_DIR, `vstsample-${slot.id}.ogg`);
  if (!existsSync(ogg)) {
    entries[file] = { name: inst.name, type, slotId: slot.id, slotNote: slot.note, skipReason: 'staged-file-missing', oggPath: ogg };
    skipped++;
    continue;
  }
  try {
    const expectedHz = hzFromMidi(midiFromNoteName(slot.note));
    // Primary: pYIN (same algorithm as legacy sonic-annotator).
    const pyin = pyinResults.get(ogg);
    let detectedHz = pyin?.f0Hz ?? null;
    let detector = pyin?.f0Hz ? 'pyin' : null;
    // Fallback: FFT + HPS, only when pYIN couldn't track or wasn't run.
    if (detectedHz == null) {
      const pcm = decodeOggToFloat32(ogg);
      const win = trimAndWindow(pcm, 1.0);
      if (win.length < 1024) {
        entries[file] = { name: inst.name, type, slotId: slot.id, slotNote: slot.note, skipReason: 'window-too-short' };
        skipped++;
        continue;
      }
      detectedHz = dominantPeakHz(win);
      detector = 'fft-hps';
    }
    const legacyAdj = classifyByLegacyBins(detectedHz);
    const ratioAdj = classifyByOctaveRatio(detectedHz, expectedHz);
    const adjustment = ratioAdj ?? legacyAdj ?? 0;
    entries[file] = {
      name: inst.name,
      type,
      lowLevelType: inst.lowLevelType,
      catalogId: inst.catalogId ?? null,
      slotId: slot.id,
      slotNote: slot.note,
      expectedHz: Number(expectedHz.toFixed(2)),
      detectedHz: Number(detectedHz.toFixed(2)),
      detector,
      voicedFraction: pyin?.voicedFraction ?? null,
      ratioOctaves: Number((Math.log2(detectedHz / expectedHz)).toFixed(3)),
      legacyAdjustment: legacyAdj,
      ratioAdjustment: ratioAdj,
      adjustment,
    };
    classified++;
  } catch (e) {
    entries[file] = { name: inst.name, type, slotId: slot.id, slotNote: slot.note, error: String(e.message ?? e) };
    skipped++;
  }
}

mkdirSync(dirname(outPath), { recursive: true });
const out = {
  schemaVersion: 1,
  renderDir,
  summary: { totalInsts: files.length, classified, skipped },
  entries,
};
writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);

console.error(`[classify-octave] ${classified}/${files.length} classified, ${skipped} skipped`);
console.error(`[classify-octave] wrote ${outPath}`);

// Pretty-print a one-line-per-inst summary for human eyes
for (const file of files) {
  const e = entries[file];
  if (e.adjustment === undefined) {
    console.error(`  ${file}  ${(e.name || '').padEnd(40)} (skipped: ${e.skipReason || e.error})`);
  } else {
    const tag = `adj=${e.adjustment >= 0 ? '+' : ''}${e.adjustment}`;
    console.error(
      `  ${file}  ${(e.name || '').padEnd(40)} note=${e.slotNote.padEnd(5)} expected=${String(e.expectedHz).padStart(7)} Hz  detected=${String(e.detectedHz).padStart(7)} Hz [${(e.detector || '').padEnd(7)}]  ratioOct=${String(e.ratioOctaves).padStart(6)}  ${tag}`,
    );
  }
}
