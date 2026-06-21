#!/usr/bin/env node
// docs/54k Keys/Pad pitch-debug diagnostic harness.
//
// Stages a synthetic 440 Hz sine wave (A4 = MIDI 69) into the engine's
// Keys vstsample slots and silences the other families, then renders
// the brain's chorus1 progression and FFTs the result to determine
// what pitches Tracktion actually plays.
//
// Two modes — driven by CASPERAKI_PITCH_DIAG_MODE:
//   * `c2..c6`      — the current fixture (17 slots c2..c6).
//   * `single-c4`   — proposed fix: all 17 slots declare note=c4 so the
//                     engine collapses to one zone covering MIDI 0..180
//                     rooted at C4.
//
// Output: writes the staged inst-3.json, runs prestage staging, then
// invokes the native binary if available and FFT-analyses out.wav.
//
// Run after `pnpm emit:brain-roundtrip` so the manifest is current.
//
//   CASPERAKI_PITCH_DIAG_MODE=c2..c6    node scripts/pitch-diagnostic.mjs
//   CASPERAKI_PITCH_DIAG_MODE=single-c4 node scripts/pitch-diagnostic.mjs

import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SAMPLES = resolve(ROOT, 'samples');
const OUT = resolve(ROOT, 'out/brain-roundtrip');
const TEMP_DIR = join(homedir(), '.config', 'CasperakiSpike', 'Temporary');
const DIAG_DIR = resolve(ROOT, 'out/pitch-diag');

mkdirSync(DIAG_DIR, { recursive: true });
mkdirSync(TEMP_DIR, { recursive: true });

const MODE = process.env.CASPERAKI_PITCH_DIAG_MODE ?? 'c2..c6';
const SINE_HZ = Number.parseFloat(process.env.CASPERAKI_PITCH_DIAG_HZ ?? '440');
const SR = 44100;

// 1) Generate a 1-second mono sine at SINE_HZ; encode as Ogg-Vorbis so
//    Tracktion's AudioFormatManager content-detects it as Vorbis.
const sinePath = resolve(DIAG_DIR, `sine-${SINE_HZ}hz.ogg`);
if (!existsSync(sinePath)) {
  // ffmpeg -f lavfi -i "sine=frequency=440:sample_rate=44100:duration=1" -c:a libvorbis sine.ogg
  execFileSync(
    'ffmpeg',
    [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi',
      '-i', `sine=frequency=${SINE_HZ}:sample_rate=${SR}:duration=2`,
      '-ac', '2',
      '-c:a', 'libvorbis', '-q:a', '5',
      sinePath,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  console.error(`[pitch-diag] generated ${sinePath} (${SINE_HZ} Hz mono 2s)`);
}

// 2) Patch inst-3.json (Keys) for the chosen mode.
const instPath = resolve(OUT, 'inst-3.json');
const inst = JSON.parse(readFileSync(instPath, 'utf-8'));
const NOTES_C2_TO_C6 = [
  'c2', 'd#2', 'f#2', 'a2',
  'c3', 'd#3', 'f#3', 'a3',
  'c4', 'd#4', 'f#4', 'a4',
  'c5', 'd#5', 'f#5', 'a5',
  'c6',
];
if (MODE === 'single-c4') {
  inst.samples.forEach((s) => { s.note = 'c4'; });
} else {
  inst.samples.forEach((s, i) => { s.note = NOTES_C2_TO_C6[i]; });
}
writeFileSync(instPath, JSON.stringify(inst, null, 2) + '\n');
console.error(`[pitch-diag] patched ${instPath} mode=${MODE}`);

// 3) Stage the sine into every Keys vstsample slot, into Drums playsample
//    slots (silenced), into Bass+Pad slots (silenced).
const drumsInst = JSON.parse(readFileSync(resolve(OUT, 'inst-1.json'), 'utf-8'));
const bassInst  = JSON.parse(readFileSync(resolve(OUT, 'inst-2.json'), 'utf-8'));
const padInst   = JSON.parse(readFileSync(resolve(OUT, 'inst-4.json'), 'utf-8'));

// Silence sample: a near-empty Ogg generated once.
const silentPath = resolve(DIAG_DIR, 'silent.ogg');
if (!existsSync(silentPath)) {
  execFileSync(
    'ffmpeg',
    [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi',
      '-i', `anullsrc=channel_layout=stereo:sample_rate=${SR}:duration=1`,
      '-c:a', 'libvorbis', '-q:a', '3',
      silentPath,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

for (const id of Object.values(drumsInst.ids ?? {})) {
  copyFileSync(silentPath, join(TEMP_DIR, `playsample-${id}.ogg`));
}
for (const s of bassInst.samples ?? []) {
  copyFileSync(silentPath, join(TEMP_DIR, `vstsample-${s.id}.ogg`));
}
for (const s of padInst.samples ?? []) {
  copyFileSync(silentPath, join(TEMP_DIR, `vstsample-${s.id}.ogg`));
}
for (const s of inst.samples ?? []) {
  copyFileSync(sinePath, join(TEMP_DIR, `vstsample-${s.id}.ogg`));
}
console.error(`[pitch-diag] staged sine into ${inst.samples.length} Keys slot(s); silenced drums+bass+pad`);

// 4) Re-render via the native binary (if present).
const bin = resolve(ROOT, 'native/build/casperaki_spike_artefacts/Debug/casperaki_spike');
const renderOut = resolve(DIAG_DIR, `out.${MODE}.wav`);
if (existsSync(bin)) {
  if (existsSync(renderOut)) {
    try { execFileSync('rm', ['-f', renderOut]); } catch {}
  }
  console.error(`[pitch-diag] rendering ${renderOut} (mode=${MODE}) ...`);
  try {
    execFileSync(bin, [OUT, 'http://127.0.0.1:8080', renderOut], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 240_000,
    });
  } catch (err) {
    // The engine emits JUCE leak warnings on shutdown — non-fatal.
  }
  if (!existsSync(renderOut)) {
    console.error(`[pitch-diag] native render did not produce ${renderOut}`);
    process.exit(2);
  }
  console.error(`[pitch-diag] render done: ${renderOut}`);
} else {
  console.error(`[pitch-diag] native binary not found at ${bin} — render skipped`);
  process.exit(2);
}

// 5) FFT-analyse the chorus1 segment of out.wav.
//
//    The brain Song packs 14 segments × varying bars at 120 bpm. With
//    songStructure intro=8b + verse1=8b + verse2=8b + preChorus1=8b +
//    chorus1=8b ..., chorus1 starts at bar 32 (= 32*4 beats = 128 beats
//    = 64 seconds at 120 bpm). Chorus1 is 8 bars = 16 seconds.
//
//    We sample a 1-second window in the middle of chorus1's first bar
//    (around t = 64s + 0.5s = 64.5s) and report the top-5 frequency
//    peaks by power.

const wavBuf = readFileSync(renderOut);
const fmt = readWavHeader(wavBuf);
console.error(
  `[pitch-diag] WAV: ${fmt.sampleRate} Hz, ${fmt.channels} ch, ${fmt.bitsPerSample}-bit, ` +
  `${(fmt.frameCount / fmt.sampleRate).toFixed(2)}s`,
);

const startSec = Number.parseFloat(process.env.CASPERAKI_PITCH_DIAG_START_SEC ?? '64.5');
const windowSec = Number.parseFloat(process.env.CASPERAKI_PITCH_DIAG_WIN_SEC ?? '1.0');

const peaks = analysePeaks(wavBuf, fmt, startSec, windowSec);
console.error(`\n[pitch-diag] top-8 spectral peaks in window [${startSec.toFixed(2)}, ${(startSec + windowSec).toFixed(2)}]s:`);
console.error(`  rank | freq (Hz) | nearest MIDI note     | dB`);
for (let i = 0; i < peaks.length; i++) {
  const p = peaks[i];
  console.error(
    `  ${String(i + 1).padStart(4)} | ${p.hz.toFixed(2).padStart(9)} | ${midiFromHz(p.hz).padStart(20)} | ${p.db.toFixed(1)}`,
  );
}

console.error(`\n[pitch-diag] expected for chorus1 bar 0 (chord=C, Keys voicing=oneOctaveMid):`);
console.error('  expected MIDI [60, 55, 52] = [C4, G3, E3]');
console.error('  expected freqs:');
for (const m of [60, 55, 52]) {
  console.error(`    MIDI ${m} (${midiName(m)}) = ${midiToHz(m).toFixed(2)} Hz`);
}

console.error('\n[pitch-diag] interpretation:');
console.error('  - if mode=c2..c6, peaks should cluster near the SOURCE freq (' + SINE_HZ + ' Hz) ± 1 semitone.');
console.error('  - if mode=single-c4, peaks should land on the expected chord freqs (261, 196, 165 Hz).');

writeFileSync(
  resolve(DIAG_DIR, `peaks.${MODE}.json`),
  JSON.stringify(
    {
      mode: MODE,
      sineHz: SINE_HZ,
      windowSec: { start: startSec, length: windowSec },
      wav: fmt,
      peaks,
      expected: [60, 55, 52].map((m) => ({ midi: m, name: midiName(m), hz: midiToHz(m) })),
    },
    null,
    2,
  ),
);
console.error(`[pitch-diag] wrote ${resolve(DIAG_DIR, `peaks.${MODE}.json`)}`);

// ---------------------------------------------------------------------------
// WAV reader + naïve DFT-with-Goertzel-on-a-coarse-grid.
// ---------------------------------------------------------------------------

function readWavHeader(buf) {
  // Minimal 44-byte / 24-bit WAV reader. PCM, integer samples.
  if (buf.slice(0, 4).toString() !== 'RIFF' || buf.slice(8, 12).toString() !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  let off = 12;
  let fmt;
  let dataOff = -1;
  let dataLen = 0;
  while (off + 8 <= buf.length) {
    const tag = buf.slice(off, off + 4).toString();
    const size = buf.readUInt32LE(off + 4);
    if (tag === 'fmt ') {
      const audioFormat = buf.readUInt16LE(off + 8);
      const channels = buf.readUInt16LE(off + 10);
      const sampleRate = buf.readUInt32LE(off + 12);
      const bitsPerSample = buf.readUInt16LE(off + 22);
      fmt = { audioFormat, channels, sampleRate, bitsPerSample };
    } else if (tag === 'data') {
      dataOff = off + 8;
      dataLen = size;
      break;
    }
    off += 8 + size + (size & 1);
  }
  if (!fmt || dataOff < 0) throw new Error('missing fmt or data chunk');
  const bytesPerSample = fmt.bitsPerSample / 8;
  const frameBytes = bytesPerSample * fmt.channels;
  const frameCount = Math.floor(dataLen / frameBytes);
  return { ...fmt, dataOff, dataLen, bytesPerSample, frameBytes, frameCount };
}

function readSamplesMono(buf, fmt, startFrame, lenFrames) {
  // Return a Float32Array of mono samples, downmixed by averaging channels.
  const out = new Float32Array(lenFrames);
  const bps = fmt.bytesPerSample;
  for (let i = 0; i < lenFrames; i++) {
    let acc = 0;
    for (let c = 0; c < fmt.channels; c++) {
      const off = fmt.dataOff + (startFrame + i) * fmt.frameBytes + c * bps;
      let s = 0;
      if (bps === 2) {
        s = buf.readInt16LE(off) / 32768;
      } else if (bps === 3) {
        const b0 = buf[off], b1 = buf[off + 1], b2 = buf[off + 2];
        let v = (b2 << 16) | (b1 << 8) | b0;
        if (v & 0x800000) v |= ~0xffffff;
        s = v / 8388608;
      } else if (bps === 4) {
        s = buf.readInt32LE(off) / 2147483648;
      } else {
        throw new Error(`unsupported bitsPerSample ${fmt.bitsPerSample}`);
      }
      acc += s;
    }
    out[i] = acc / fmt.channels;
  }
  return out;
}

function analysePeaks(buf, fmt, startSec, lenSec) {
  const startFrame = Math.floor(startSec * fmt.sampleRate);
  const lenFrames = Math.min(
    Math.floor(lenSec * fmt.sampleRate),
    fmt.frameCount - startFrame,
  );
  if (lenFrames <= 1024) throw new Error('window too short');
  const samples = readSamplesMono(buf, fmt, startFrame, lenFrames);
  // Hann window.
  const win = new Float32Array(lenFrames);
  for (let i = 0; i < lenFrames; i++) {
    win[i] = samples[i] * 0.5 * (1 - Math.cos((2 * Math.PI * i) / (lenFrames - 1)));
  }

  // Goertzel on a chromatic grid from MIDI 24 (C1=32.7) to MIDI 96 (C7=2093).
  /** @type {{midi: number, hz: number, power: number}[]} */
  const candidates = [];
  for (let midi = 24; midi <= 96; midi += 1) {
    const hz = midiToHz(midi);
    const k = (2 * Math.PI * hz) / fmt.sampleRate;
    const coeff = 2 * Math.cos(k);
    let q0 = 0, q1 = 0, q2 = 0;
    for (let i = 0; i < lenFrames; i++) {
      q0 = coeff * q1 - q2 + win[i];
      q2 = q1;
      q1 = q0;
    }
    const power = q1 * q1 + q2 * q2 - q1 * q2 * coeff;
    candidates.push({ midi, hz, power });
  }
  // Local maxima: peaks where power > both neighbours.
  /** @type {{midi: number, hz: number, db: number}[]} */
  const peaks = [];
  for (let i = 1; i < candidates.length - 1; i++) {
    const a = candidates[i - 1].power;
    const b = candidates[i].power;
    const c = candidates[i + 1].power;
    if (b > a && b > c) {
      const db = 10 * Math.log10(b / lenFrames + 1e-30);
      peaks.push({ midi: candidates[i].midi, hz: candidates[i].hz, db });
    }
  }
  peaks.sort((x, y) => y.db - x.db);
  return peaks.slice(0, 8);
}

function midiToHz(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}
function midiName(m) {
  const N = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  return `${N[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
}
function midiFromHz(hz) {
  const m = 12 * Math.log2(hz / 440) + 69;
  const r = Math.round(m);
  const cents = Math.round((m - r) * 100);
  return `${midiName(r)} (${r}) ${cents >= 0 ? '+' : ''}${cents}c`;
}
