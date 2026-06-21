#!/usr/bin/env node
// docs/58a — Keys-only render harness.
//
// Renders a Keys-only fixture so the piano-sustain delta can be A/B-tested
// against a single binary change without re-running the full 8-genre matrix
// (~10 min). The harness:
//
//   1. Builds (or reuses) a Keys-only fixture under
//      apps/engine-spike/out/keys-fixture/. The fixture is derived from
//      the ballad render artefacts in out/all-genre-render-smoke/ballad/
//      (only because ballad is one of the genres where Keys is the
//      dominant tonal lane; any genre with Keys=true in arrangement
//      would do).
//   2. Mutes every non-Keys lane in song.json by setting
//      arrangement[seg].instruments.{Drums,Bass,Pad,Synths,Guitar,Loop,...}
//      to false. Keeps Keys=true.
//   3. Drops fxReverse / transitions / loops at the arrangement level so
//      the only audible energy in the render comes from the Keys sampler.
//   4. Renders with the current engine binary.
//   5. Reports: full WAV peak/rms + tail-region rms in the last 0.5 s
//      (the trailing silence is the let-ring tell — hard-cut → ~floor;
//      let-ring → audible decay).
//
// Usage:
//   node apps/engine-spike/scripts/render-keys-fixture.mjs --label baseline
//   # ... rebuild the engine with a candidate fix ...
//   node apps/engine-spike/scripts/render-keys-fixture.mjs --label fix
//   node apps/engine-spike/scripts/render-keys-fixture.mjs --compare baseline fix
//
// Each render writes out/keys-fixture/<label>.wav and <label>.json next to
// it. --compare prints a Δ table from two prior JSON reports.

import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyseWav } from './check-wav.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(ROOT, '../..');
const BIN = resolve(ROOT, 'native/build/casperaki_spike_artefacts/Debug/casperaki_spike');
const SOURCE_RENDER = resolve(ROOT, 'out/all-genre-render-smoke/ballad');
const OUT_DIR = resolve(ROOT, 'out/keys-fixture');
const STUB_URL = process.env.STUB_URL ?? 'http://127.0.0.1:8080';
const TAIL_WINDOW_SEC = 0.5;

function parseArgs(argv) {
  const args = { label: null, compare: null, rebuild: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--label') args.label = argv[++i];
    else if (a === '--compare') args.compare = [argv[++i], argv[++i]];
    else if (a === '--rebuild') args.rebuild = true;
    else if (a === '-h' || a === '--help') args.help = true;
    else throw new Error(`unknown arg: ${a}`);
  }
  return args;
}

function ensureFixture({ rebuild }) {
  const songPath = join(OUT_DIR, 'song.json');
  if (existsSync(songPath) && !rebuild) return;

  if (!existsSync(SOURCE_RENDER)) {
    throw new Error(
      `source render missing: ${SOURCE_RENDER}\n` +
      `run \`node apps/engine-spike/scripts/render-all-genres.mjs\` first (or unset --rebuild)`,
    );
  }

  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  // Copy every inst-*.json + asset-manifest + brain-song so the engine has
  // a complete envelope. song.json gets rewritten below.
  for (const name of readdirSafe(SOURCE_RENDER)) {
    if (name === 'out.wav' || name === 'out-plugins.wav' || name === 'render.log') continue;
    cpSync(join(SOURCE_RENDER, name), join(OUT_DIR, name), { recursive: true });
  }

  const song = JSON.parse(readFileSync(join(OUT_DIR, 'song.json'), 'utf-8'));
  muteAllButKeys(song);
  writeFileSync(join(OUT_DIR, 'song.json'), `${JSON.stringify(song, null, 2)}\n`);
}

function readdirSafe(p) {
  return execFileSync('ls', [p]).toString().split('\n').filter(Boolean);
}

function muteAllButKeys(song) {
  const arrangement = song.arrangement ?? {};
  for (const segName of Object.keys(arrangement)) {
    const seg = arrangement[segName];
    if (seg?.instruments && typeof seg.instruments === 'object') {
      for (const fam of Object.keys(seg.instruments)) {
        if (fam === 'Keys') continue;
        seg.instruments[fam] = false;
      }
    }
    // Drop transitions and fx so they don't leak energy into the tail
    // window. The matrix's transitionLaneActive check at
    // render-all-genres.mjs:169 reads arrangement[seg].transitions, so
    // clearing the array is the supported "no transitions here" shape.
    if (Array.isArray(seg?.transitions)) seg.transitions = [];
  }
}

function render(wavOut, env = {}) {
  if (existsSync(wavOut)) rmSync(wavOut);
  const res = spawnSync(BIN, [OUT_DIR, STUB_URL, wavOut], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
    cwd: REPO_ROOT,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) {
    const tail = (res.stderr?.toString() ?? '').trim().split('\n').slice(-20).join('\n');
    throw new Error(`render failed (rc=${res.status}):\n${tail}`);
  }
}

function tailRms(wavPath, tailSec) {
  // Re-read the WAV and compute RMS in the last `tailSec` seconds. Reuses
  // analyseWav's full-file machinery, then re-decodes the trailing window
  // with a focused pass — cheap because the fixture is short.
  const full = analyseWav(wavPath);
  const buf = readFileSync(wavPath);
  let offset = 12;
  let fmt;
  let dataStart = -1;
  let dataSize = -1;
  while (offset + 8 <= buf.length) {
    const tag = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (tag === 'fmt ') {
      fmt = {
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (tag === 'data') {
      dataStart = body;
      dataSize = size;
      break;
    }
    offset = body + size + (size % 2);
  }
  const { channels, sampleRate, bitsPerSample } = fmt;
  const bps = bitsPerSample / 8;
  const stride = channels * bps;
  const totalFrames = Math.floor(dataSize / stride);
  const tailFrames = Math.min(totalFrames, Math.floor(tailSec * sampleRate));
  const startFrame = totalFrames - tailFrames;
  const scale = bps === 2 ? 32768 : bps === 3 ? 8388608 : 2147483648;
  let sum2 = 0;
  let n = 0;
  let peak = 0;
  for (let f = startFrame; f < totalFrames; f++) {
    const fo = dataStart + f * stride;
    for (let c = 0; c < channels; c++) {
      let s = 0;
      const o = fo + c * bps;
      if (bps === 2) s = buf.readInt16LE(o);
      else if (bps === 3) {
        const u = buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16);
        s = u & 0x800000 ? u | 0xff000000 : u;
      } else if (bps === 4) s = buf.readInt32LE(o);
      const v = s / scale;
      sum2 += v * v;
      if (Math.abs(v) > peak) peak = Math.abs(v);
      n++;
    }
  }
  const rms = n > 0 ? Math.sqrt(sum2 / n) : 0;
  return {
    full,
    tail: {
      windowSec: tailSec,
      rms,
      rmsDb: rms > 0 ? 20 * Math.log10(rms) : Number.NEGATIVE_INFINITY,
      peak,
      peakDb: peak > 0 ? 20 * Math.log10(peak) : Number.NEGATIVE_INFINITY,
    },
  };
}

function fmtDb(v) {
  if (!Number.isFinite(v)) return '-inf';
  return v.toFixed(3) + ' dB';
}

function runRender(label) {
  if (!existsSync(BIN)) {
    throw new Error(
      `engine binary missing: ${BIN}\n` +
      `build first: cd apps/engine-spike/native && cmake --build build --target casperaki_spike`,
    );
  }
  ensureFixture({ rebuild: false });
  const wavOut = join(OUT_DIR, `${label}.wav`);
  const reportOut = join(OUT_DIR, `${label}.json`);
  const startedAt = Date.now();
  render(wavOut);
  const elapsedSec = (Date.now() - startedAt) / 1000;
  const stats = tailRms(wavOut, TAIL_WINDOW_SEC);
  const report = {
    label,
    binary: BIN,
    elapsedSec: +elapsedSec.toFixed(3),
    durationSec: +stats.full.durationSec.toFixed(3),
    peakDb: +stats.full.peakDb.toFixed(3),
    rmsDb: +stats.full.rmsDb.toFixed(3),
    tail: {
      windowSec: TAIL_WINDOW_SEC,
      peakDb: Number.isFinite(stats.tail.peakDb) ? +stats.tail.peakDb.toFixed(3) : null,
      rmsDb: Number.isFinite(stats.tail.rmsDb) ? +stats.tail.rmsDb.toFixed(3) : null,
    },
  };
  writeFileSync(reportOut, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[keys-fixture] ${label}: dur=${report.durationSec}s peak=${report.peakDb}dB rms=${report.rmsDb}dB ` +
    `tail-rms=${fmtDb(stats.tail.rmsDb)} tail-peak=${fmtDb(stats.tail.peakDb)} (in ${report.elapsedSec}s)`);
  console.log(`[keys-fixture] wrote ${wavOut}`);
  console.log(`[keys-fixture] wrote ${reportOut}`);
}

function runCompare(a, b) {
  const ra = JSON.parse(readFileSync(join(OUT_DIR, `${a}.json`), 'utf-8'));
  const rb = JSON.parse(readFileSync(join(OUT_DIR, `${b}.json`), 'utf-8'));
  const row = (k, va, vb, unit = 'dB') => {
    const dv = (typeof va === 'number' && typeof vb === 'number') ? (vb - va).toFixed(3) : '—';
    console.log(`  ${k.padEnd(14)} ${String(va).padStart(10)}  ${String(vb).padStart(10)}  Δ=${String(dv).padStart(8)} ${unit}`);
  };
  console.log(`\n[keys-fixture] compare ${a} → ${b}`);
  console.log(`  ${'metric'.padEnd(14)} ${a.padStart(10)}  ${b.padStart(10)}  delta`);
  row('durationSec', ra.durationSec, rb.durationSec, 's');
  row('peakDb', ra.peakDb, rb.peakDb);
  row('rmsDb', ra.rmsDb, rb.rmsDb);
  row('tail.peakDb', ra.tail.peakDb, rb.tail.peakDb);
  row('tail.rmsDb', ra.tail.rmsDb, rb.tail.rmsDb);
  // Interpretation cheat-sheet.
  const tailDelta = (typeof ra.tail.rmsDb === 'number' && typeof rb.tail.rmsDb === 'number')
    ? rb.tail.rmsDb - ra.tail.rmsDb : null;
  console.log('');
  if (tailDelta == null) {
    console.log('  tail rms not comparable (one side is null / -inf)');
  } else if (tailDelta >= 6) {
    console.log(`  ✓ tail rms up ${tailDelta.toFixed(2)} dB — let-ring landed (≥ +6 dB threshold)`);
  } else if (tailDelta >= 1) {
    console.log(`  ~ tail rms up ${tailDelta.toFixed(2)} dB — partial; consider stronger tail or option (a)`);
  } else {
    console.log(`  ✗ tail rms change ${tailDelta.toFixed(2)} dB — no measurable let-ring`);
  }
}

function usage() {
  console.log(`Usage:
  render-keys-fixture.mjs --label LABEL [--rebuild]
  render-keys-fixture.mjs --compare LABEL_A LABEL_B
  render-keys-fixture.mjs --help

Renders a Keys-only fixture once per invocation and writes
  out/keys-fixture/<label>.wav  +  out/keys-fixture/<label>.json
The fixture is derived from out/all-genre-render-smoke/ballad/ (must exist).
Pass --rebuild to re-derive the fixture from source.`);
}

const args = parseArgs(process.argv);
if (args.help) { usage(); process.exit(0); }
if (args.compare) { runCompare(args.compare[0], args.compare[1]); process.exit(0); }
if (!args.label) { usage(); process.exit(2); }
runRender(args.label);
