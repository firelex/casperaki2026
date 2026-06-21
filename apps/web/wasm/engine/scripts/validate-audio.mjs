#!/usr/bin/env node
// Audio IR-faithfulness energy oracle (docs/60 Phase 1 — sampler/mix half).
//
//   node scripts/validate-audio.mjs [genre]
//
// The audio half's oracle is structural/synthetic, NOT a WAV null against the
// golden out.wav (the golden was rendered with stub samples, its VST tonal/bass
// lanes are silent, and it carries FX — Phase 1 is no-FX; see memory
// wasm-engine-phase1-sampler). So instead of comparing waveforms we assert that
// the rendered audio's ENERGY lands where the resolved IR places notes/clips and
// is silent where the IR is empty:
//
//   1. non-silent + full-length        — a real track, not a stub of zeros
//   2. active-window coverage          — (almost) every window the IR fills with
//                                         a note/step-hit/wave clip carries audible
//                                         energy ("energy where the notes are")
//   3. deep-silence windows are quiet  — windows with no IR activity nearby (incl.
//                                         a release-tail guard) stay near zero
//   4. discrimination                  — active windows are far louder than the
//                                         deepest-silence windows (when any exist)
//
// It drives ./build/casperaki_render (the WAV) and ./build/casperaki_resolve (the
// IR), reading beat->sec from each genre's song.json tempo.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as presolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const engineDir = presolve(here, '..');
const RENDER_BIN = presolve(engineDir, 'build/casperaki_render');
const RESOLVE_BIN = presolve(engineDir, 'build/casperaki_resolve');
const GENRE_ROOT = presolve(engineDir, '../../../engine-spike/out/all-genre-render-smoke');
const SAMPLES_DIR = presolve(engineDir, '../../../engine-spike/samples');

const ALL = ['ballad', 'brightPop', 'edm', 'latin', 'organicVibes', 'rock', 'schlager', 'urban'];
const only = process.argv[2];
const genres = only ? [only] : ALL;

for (const bin of [RENDER_BIN, RESOLVE_BIN]) {
  if (!existsSync(bin)) {
    console.error(`missing ${bin}\n  build it: cmake -S "${engineDir}" -B "${engineDir}/build" && cmake --build "${engineDir}/build"`);
    process.exit(2);
  }
}

// --- tunables -------------------------------------------------------------
const WIN = 0.05;             // analysis window (seconds)
const TAIL_GUARD = 2.8;       // a window is "deep silence" only if no IR activity
                              // within [-WIN, +TAIL_GUARD]s — covers the 2.5s
                              // render tail + 2.0s ADSR release ring-out.
const DRUM_HIT_SEC = 0.12;    // a step hit marks this much active time
const ACTIVE_RMS = 5e-4;      // a window "has energy" above this
const SILENCE_RMS = 5e-3;     // deep-silence windows must stay below this
const MIN_COVERAGE = 0.80;    // fraction of active windows that must have energy
const MIN_DISCRIM = 8;        // activeMeanRMS / silenceMeanRMS (when silence exists)

// --- minimal 16-bit PCM WAV reader ---------------------------------------
function readWav(path) {
  const buf = readFileSync(path);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE')
    throw new Error(`not a WAV: ${path}`);
  let off = 12, fmt = null, dataOff = 0, dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const sz = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      fmt = {
        audioFormat: buf.readUInt16LE(off + 8),
        channels: buf.readUInt16LE(off + 10),
        sampleRate: buf.readUInt32LE(off + 12),
        bits: buf.readUInt16LE(off + 22),
      };
    } else if (id === 'data') {
      dataOff = off + 8;
      dataLen = sz;
    }
    off += 8 + sz + (sz & 1);
  }
  if (!fmt || !dataOff) throw new Error(`malformed WAV: ${path}`);
  if (fmt.bits !== 16) throw new Error(`expected 16-bit PCM, got ${fmt.bits}`);
  const ch = fmt.channels;
  const frames = Math.floor(dataLen / (2 * ch));
  return { fmt, frames, dataOff, ch, buf };
}

// Per-window mean-square energy across all channels (mono-summed).
function windowEnergies(wav, winSec) {
  const { fmt, frames, dataOff, ch, buf } = wav;
  const winFrames = Math.max(1, Math.round(winSec * fmt.sampleRate));
  const nWin = Math.ceil(frames / winFrames);
  const rms = new Float64Array(nWin);
  for (let w = 0; w < nWin; w++) {
    const start = w * winFrames;
    const end = Math.min(frames, start + winFrames);
    let sumSq = 0, count = 0;
    for (let i = start; i < end; i++) {
      for (let c = 0; c < ch; c++) {
        const s = buf.readInt16LE(dataOff + (i * ch + c) * 2) / 32768;
        sumSq += s * s;
        count++;
      }
    }
    rms[w] = count ? Math.sqrt(sumSq / count) : 0;
  }
  return { rms, winFrames, nWin, sampleRate: fmt.sampleRate };
}

// --- IR -> active intervals ----------------------------------------------
function activeIntervals(ir, secPerBeat) {
  const iv = [];
  for (const t of ir.tracks) {
    for (const c of t.clips) {
      if (c.type === 'midi') {
        for (const n of c.notes || []) {
          const on = c.startSec + n.startBeat * secPerBeat;
          const off = c.startSec + (n.startBeat + n.lenBeats) * secPerBeat;
          iv.push([on, off]);
        }
      } else if (c.type === 'wave') {
        iv.push([c.startSec, c.endSec]);
      } else if (c.type === 'step') {
        for (const p of c.patterns || []) {
          if (!p.numSteps) continue;
          const stepDur = (c.endSec - c.startSec) / p.numSteps;
          for (const h of p.hits || []) {
            const on = c.startSec + h.step * stepDur;
            iv.push([on, on + DRUM_HIT_SEC]);
          }
        }
      }
    }
  }
  iv.sort((a, b) => a[0] - b[0]);
  // merge
  const merged = [];
  for (const [s, e] of iv) {
    if (merged.length && s <= merged[merged.length - 1][1] + 1e-6) {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
    } else merged.push([s, e]);
  }
  return merged;
}

function anyOverlap(intervals, a, b) {
  // intervals sorted; linear scan is fine for these sizes
  for (const [s, e] of intervals) {
    if (e < a) continue;
    if (s > b) return false;
    return true;
  }
  return false;
}

// --- per-genre check ------------------------------------------------------
function checkGenre(genre) {
  const dir = join(GENRE_ROOT, genre);
  if (!existsSync(join(dir, 'song.json'))) return { genre, skip: 'no song.json' };

  const tempo = JSON.parse(readFileSync(join(dir, 'song.json'), 'utf-8')).tempo ?? 120;
  const secPerBeat = 60 / tempo;

  const tmp = mkdtempSync(join(tmpdir(), `cspr-audio-${genre}-`));
  const wavPath = join(tmp, `${genre}.wav`);
  execFileSync(RENDER_BIN, [dir, wavPath, SAMPLES_DIR], { stdio: ['ignore', 'ignore', 'inherit'] });
  const irText = execFileSync(RESOLVE_BIN, [dir], { maxBuffer: 1 << 30 }).toString();
  const ir = JSON.parse(irText);

  const wav = readWav(wavPath);
  const { rms, winFrames, nWin, sampleRate } = windowEnergies(wav, WIN);
  const intervals = activeIntervals(ir, secPerBeat);

  const winTime = (w) => (w * winFrames) / sampleRate;

  let activeWin = 0, activeWithEnergy = 0, activeSum = 0;
  let silenceWin = 0, silenceSum = 0, silenceMax = 0;
  let globalSumSq = 0;

  for (let w = 0; w < nWin; w++) {
    const a = winTime(w);
    const b = a + WIN;
    globalSumSq += rms[w] * rms[w];
    const active = anyOverlap(intervals, a, b);
    if (active) {
      activeWin++;
      activeSum += rms[w];
      if (rms[w] >= ACTIVE_RMS) activeWithEnergy++;
    } else if (!anyOverlap(intervals, a - WIN, b + TAIL_GUARD)) {
      // deep silence: no activity nearby, even accounting for the ring-out tail
      silenceWin++;
      silenceSum += rms[w];
      silenceMax = Math.max(silenceMax, rms[w]);
    }
  }

  const globalRms = Math.sqrt(globalSumSq / nWin);
  const coverage = activeWin ? activeWithEnergy / activeWin : 0;
  const activeMean = activeWin ? activeSum / activeWin : 0;
  const silenceMean = silenceWin ? silenceSum / silenceWin : 0;
  const discrim = silenceMean > 1e-9 ? activeMean / silenceMean : Infinity;
  const wavDur = wav.frames / wav.fmt.sampleRate;

  const fails = [];
  if (globalRms < 1e-3) fails.push(`silent (globalRms=${globalRms.toExponential(2)})`);
  if (wavDur < ir.lengthSec - 0.5) fails.push(`short (wav ${wavDur.toFixed(1)}s < IR ${ir.lengthSec.toFixed(1)}s)`);
  if (wav.fmt.channels !== 2) fails.push(`not stereo (${wav.fmt.channels}ch)`);
  if (activeWin > 0 && coverage < MIN_COVERAGE)
    fails.push(`low coverage ${(coverage * 100).toFixed(1)}% (< ${(MIN_COVERAGE * 100)}%)`);
  if (silenceWin > 0 && silenceMax >= SILENCE_RMS)
    fails.push(`silence leak: max silent-window rms ${silenceMax.toExponential(2)} >= ${SILENCE_RMS}`);
  if (silenceWin > 0 && discrim < MIN_DISCRIM)
    fails.push(`weak discrimination ${discrim.toFixed(1)}x (< ${MIN_DISCRIM}x)`);

  return {
    genre, fails, wavDur, irLen: ir.lengthSec, globalRms,
    activeWin, coverage, silenceWin, silenceMax, discrim, tracks: ir.tracks.length,
  };
}

// --- run ------------------------------------------------------------------
let anyFail = false;
console.log(`audio energy oracle — window ${WIN}s, tail-guard ${TAIL_GUARD}s\n`);
for (const g of genres) {
  let r;
  try {
    r = checkGenre(g);
  } catch (e) {
    console.log(`${g.padEnd(13)} ERROR ${e.message}`);
    anyFail = true;
    continue;
  }
  if (r.skip) { console.log(`${g.padEnd(13)} SKIP ${r.skip}`); continue; }
  const status = r.fails.length ? 'FAIL' : 'PASS';
  if (r.fails.length) anyFail = true;
  const discrimStr = r.discrim === Infinity ? '∞' : `${r.discrim.toFixed(0)}x`;
  console.log(
    `${g.padEnd(13)} ${status}  dur=${r.wavDur.toFixed(1)}s/${r.irLen.toFixed(1)}s ` +
    `tracks=${r.tracks} cover=${(r.coverage * 100).toFixed(1)}% ` +
    `active=${r.activeWin} silence=${r.silenceWin} ` +
    `discrim=${discrimStr} rms=${r.globalRms.toFixed(4)}`);
  for (const f of r.fails) console.log(`              - ${f}`);
}
console.log(anyFail ? '\nFAIL' : '\nAll genres PASS');
process.exit(anyFail ? 1 : 0);
