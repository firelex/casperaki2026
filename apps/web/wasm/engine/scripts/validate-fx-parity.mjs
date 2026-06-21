#!/usr/bin/env node
// Phase 2 Scope D — the golden A/B parity validator. For each genre: render the
// full-FX WASM output (real sample library) and compare it to the native JUCE
// golden with the calibrated statistical oracle (docs/63 §7): per-1/3-octave-band
// RMS + log-spectral distance (the native render's own run-to-run wobble is
// ≤0.01 dB/band, so this is razor-tight). Time-domain NRMSE is a coarse gate only.
//
// Thresholds are deliberately loose for now (the port is converging, several FX
// are best-effort): a genre PASSES if log-spectral distance < LSD_MAX dB. Tighten
// as parity improves. Exit non-zero if any genre fails (CI-friendly).
//
//   CASPERAKI_SAMPLE_LIBRARY_ROOT=… node scripts/validate-fx-parity.mjs [genre...]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENGINE = resolve(__dirname, '..');
const RENDER = join(ENGINE, 'build', 'casperaki_render');
const COMPARE = join(__dirname, 'wav-stats-compare.mjs');
const OUT_ROOT = resolve(ENGINE, '../../../engine-spike/out/all-genre-render-smoke');
const LIB = process.env.CASPERAKI_SAMPLE_LIBRARY_ROOT ?? '';

const ALL = ['ballad', 'brightPop', 'edm', 'latin', 'organicVibes', 'rock', 'schlager', 'urban'];
const genres = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const LIST = genres.length ? genres : ALL;

// LSD (per-band spectral) is THE parity measure (§7). Time-domain NRMSE is shown
// for context only — it's ~130%+ by construction (WASM vs native are fully phase-
// decorrelated by the reverb/delay/chorus tails even when spectrally identical),
// so it is NOT a gate.
const LSD_MAX = Number(process.env.LSD_MAX ?? 2.5);     // dB, mean per-1/3-octave — tighten as parity improves

if (!existsSync(RENDER)) { console.error(`build casperaki_render first (${RENDER})`); process.exit(2); }

const tmp = mkdtempSync(join(tmpdir(), 'fxparity-'));
let fails = 0;
console.log(`Phase-2 FX parity vs golden (LSD<${LSD_MAX}dB; lib=${LIB ? 'real' : 'STUBS — install lib for real timbres'})`);
console.log('genre           LSD(dB)  maxBandΔ  NRMSE%   rmsWASM/golden   verdict');

for (const g of LIST) {
  const dir = join(OUT_ROOT, g);
  const golden = join(dir, 'out.wav');
  if (!existsSync(golden)) { console.log(`${g.padEnd(15)} (no golden — skip)`); continue; }
  const wasm = join(tmp, `${g}.wav`);
  try {
    execFileSync(RENDER, [dir, wasm, '', LIB], { env: { ...process.env, CASPERAKI_MIX: '1' }, stdio: 'ignore' });
    const out = execFileSync('node', [COMPARE, wasm, golden, '--bands', 'third', '--json']).toString();
    const r = JSON.parse(out);
    const ok = r.logSpectralDistance_dB < LSD_MAX;   // spectral parity only (see note above)
    if (!ok) fails++;
    console.log(`${g.padEnd(15)} ${String(r.logSpectralDistance_dB).padStart(6)}  ${String(r.maxBandDelta_dB).padStart(7)}  ${String(r.nrmsePct).padStart(6)}   ${String(r.rmsA_dB).padStart(6)}/${String(r.rmsB_dB).padStart(6)}   ${ok ? 'PASS' : 'FAIL'}`);
  } catch (e) {
    fails++;
    console.log(`${g.padEnd(15)} ERROR ${(e.message || e).toString().split('\n')[0]}`);
  }
}

console.log(fails === 0 ? '\nAll genres within tolerance.' : `\n${fails} genre(s) over tolerance.`);
process.exit(fails === 0 ? 0 : 1);
