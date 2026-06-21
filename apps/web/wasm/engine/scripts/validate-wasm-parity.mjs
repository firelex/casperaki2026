#!/usr/bin/env node
// WASM streaming-mixer parity guard (docs/60 Phase 1 step 6).
//
//   node scripts/validate-wasm-parity.mjs [genre]
//
// Proves the browser WASM build of the streaming mixer produces the SAME audio as
// the committed native mixer for the first N blocks of each genre — locking the
// Render.h -> Mixer.h refactor AND the emscripten port against each other.
//
// Both sides are fed BYTE-IDENTICAL stub PCM (a deterministic synthetic signal
// generated here, written to a file the native probe reads and pushed into the
// wasm heap), at a fixed 44100 Hz / 128-frame block. So any divergence is pure
// mix math (resample + gain + ADSR + sum), not decode or sample-rate. A tiny
// tolerance absorbs libm last-ULP differences (native glibc vs emscripten musl in
// pow/exp/sin); a real port bug blows past it immediately.
//
// Requires the wasm build: ./build-wasm.sh (engine-render.wasm) and the native
// build: cmake --build build (casperaki_mixer_probe + casperaki_resolve).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as presolve, join } from 'node:path';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const engineDir = presolve(here, '..');
const PROBE_BIN = presolve(engineDir, 'build/casperaki_mixer_probe');
const WASM = presolve(engineDir, '../../public/wasm/engine-render.wasm');
const GENRE_ROOT = presolve(engineDir, '../../../engine-spike/out/all-genre-render-smoke');

const ALL = ['ballad', 'brightPop', 'edm', 'latin', 'organicVibes', 'rock', 'schlager', 'urban'];
const only = process.argv[2];
const genres = only ? [only] : ALL;

const NUM_BLOCKS = 4000;        // ~11.6 s at 44100/128 — covers many note onsets
const BLOCK = 128;
const SR = 44100;
const ROLE_FRAMES = 8000;       // stub length per role (mono)

// Pass criteria. Native (glibc) and wasm (musl) differ only by last-ULP libm
// (powf in the playback ratio, exp/log in the gain); that occasionally cascades
// through the 32-voice cap into a whole-voice (O(1)) divergence in dense genres.
// So we don't demand bit-equality — we demand the two renders are the SAME signal
// to well within a fraction of a percent (NRMSE), with the rare cascade samples a
// negligible slice. A real port bug (wrong join/note/lane) blows past both.
// NRMSE high-water mark is organicVibes (~1.6%): the densest genre, where the
// voice-cap cascade stacks. 3% leaves headroom for libm version drift; badFrac is
// the sharp bug-catcher (a wrong lane disagrees on a broad swath, not <0.1%).
const MAX_NRMSE = 0.03;         // normalized RMS error (rmsDiff / rmsSignal)
const BAD_FLOOR = 5e-3;         // a sample disagrees past this abs floor ...
const BAD_REL = 0.05;           // ... or this fraction of |native|
const MAX_BAD_FRAC = 0.01;      // at most 1% of nonzero samples may disagree

for (const [bin, hint] of [[PROBE_BIN, 'cmake --build build'], [WASM, './build-wasm.sh']]) {
  if (!existsSync(bin)) {
    console.error(`missing ${bin}\n  build it: ${hint}`);
    process.exit(2);
  }
}

// --- deterministic synthetic stub PCM ----------------------------------------
// A SMOOTH, band-limited tone (low harmonics + a linear decay), NOT white noise.
// The resampler reads at a fractional rate derived from a float pow() ratio that
// can differ by a last ULP between native glibc and emscripten musl; on white
// noise that femto-sample phase drift maps to huge amplitude diffs (adjacent
// samples uncorrelated), but on a smooth signal it maps to a proportionally tiny
// amplitude diff — so this still exercises resample+gain+ADSR+sum end-to-end
// while staying within a sane tolerance. The bytes are identical on both sides
// (generated here, shared), so only the mix MATH is under test.
function makeStub(role) {
  const pcm = new Float32Array(ROLE_FRAMES);
  const f0 = 80 + role * 37;            // low fundamentals, distinct per role
  const f1 = 2 * f0;
  for (let i = 0; i < ROLE_FRAMES; i++) {
    const t = i / SR;
    const decay = 1 - i / ROLE_FRAMES;
    const v = decay * (0.6 * Math.sin(2 * Math.PI * f0 * t) +
                       0.3 * Math.sin(2 * Math.PI * f1 * t));
    pcm[i] = Math.fround(v);
  }
  return pcm;
}
// roles in order: kick,snare,hat,tone,bass
const STUBS = [makeStub(1), makeStub(2), makeStub(3), makeStub(4), makeStub(5)];

// Serialize to the probe's stub-pcm format: per role int32 frames, channels,
// sampleRate, then planar float32.
function writeStubPcmFile(path) {
  const parts = [];
  for (const pcm of STUBS) {
    const hdr = new Int32Array([pcm.length, 1, SR]);
    parts.push(Buffer.from(hdr.buffer));
    parts.push(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
  }
  writeFileSync(path, Buffer.concat(parts));
}

// --- genre envelope -> song + inst JSON texts (sorted by numeric id) ---------
function loadEnvelope(genre) {
  const dir = join(GENRE_ROOT, genre);
  const song = readFileSync(join(dir, 'song.json'));
  const insts = readdirSync(dir)
    .filter((n) => /^inst-\d+\.json$/.test(n))
    .sort((a, b) => parseInt(a.slice(5), 10) - parseInt(b.slice(5), 10))
    .map((n) => readFileSync(join(dir, n)));
  return { dir, song, insts };
}

// --- WASM render of the first N blocks ---------------------------------------
async function wasmRender(env) {
  const bytes = readFileSync(WASM);
  const mod = await WebAssembly.compile(bytes);
  // The standalone build pulls in 5 unused WASI stdio imports; stub them. Memory
  // growth (ALLOW_MEMORY_GROWTH) adds env.emscripten_notify_memory_growth — a
  // no-op for us (we read e.memory.buffer fresh each access).
  const wasi = {
    fd_close: () => 0, fd_write: () => 0, fd_seek: () => 0,
    environ_sizes_get: () => 0, environ_get: () => 0,
  };
  const inst = await WebAssembly.instantiate(mod, {
    wasi_snapshot_preview1: wasi,
    env: { emscripten_notify_memory_growth: () => {} },
  });
  const e = inst.exports;
  if (typeof e._initialize === 'function') e._initialize();

  const heap = () => e.memory.buffer;
  const malloc = (n) => e.malloc(n);
  const writeBytes = (buf) => {
    const p = malloc(buf.length);
    new Uint8Array(heap(), p, buf.length).set(buf);
    return p;
  };
  const writeFloats = (f32) => {
    const p = malloc(f32.byteLength);
    new Float32Array(heap(), p, f32.length).set(f32);
    return p;
  };

  e.mixer_config(SR, BLOCK);
  STUBS.forEach((pcm, role) => {
    const ptr = writeFloats(pcm);
    e.mixer_set_sample(role, ptr, 0, pcm.length, 1, SR);
    e.free(ptr);
  });

  const songPtr = writeBytes(env.song);
  const blob = Buffer.concat(env.insts);
  const blobPtr = writeBytes(blob);
  const lens = new Int32Array(env.insts.map((b) => b.length));
  const lensPtr = malloc(lens.byteLength);
  new Int32Array(heap(), lensPtr, lens.length).set(lens);

  const total = e.mixer_build(songPtr, env.song.length, blobPtr, lensPtr, env.insts.length);
  if (e.mixer_last_error() !== 0) throw new Error('wasm mixer_build failed');

  const out = new Float32Array(NUM_BLOCKS * 2 * BLOCK);
  for (let b = 0; b < NUM_BLOCKS; b++) {
    e.mixer_pull(BLOCK);
    const lPtr = e.mixer_left(), rPtr = e.mixer_right();
    const L = new Float32Array(heap(), lPtr, BLOCK);
    const R = new Float32Array(heap(), rPtr, BLOCK);
    out.set(L, b * 2 * BLOCK);
    out.set(R, b * 2 * BLOCK + BLOCK);
  }
  return { out, total };
}

// --- per-genre compare -------------------------------------------------------
async function checkGenre(genre, pcmFile) {
  const env = loadEnvelope(genre);
  const tmp = mkdtempSync(join(tmpdir(), `cspr-parity-${genre}-`));
  const nativeRaw = join(tmp, 'native.raw');
  execFileSync(PROBE_BIN, [env.dir, pcmFile, String(NUM_BLOCKS), nativeRaw],
    { stdio: ['ignore', 'ignore', 'inherit'] });
  const nativeBuf = readFileSync(nativeRaw);
  const native = new Float32Array(nativeBuf.buffer, nativeBuf.byteOffset,
    nativeBuf.byteLength / 4);

  const { out: wasm, total } = await wasmRender(env);

  const nN = Math.min(native.length, wasm.length);
  let maxAbs = 0, sumSqDiff = 0, sumSqSig = 0, nonZero = 0, bad = 0, firstBad = -1;
  for (let i = 0; i < nN; i++) {
    const d = Math.abs(native[i] - wasm[i]);
    if (d > maxAbs) maxAbs = d;
    sumSqDiff += d * d;
    sumSqSig += native[i] * native[i];
    if (native[i] !== 0) nonZero++;
    // A sample "disagrees" only past a relative+floor tolerance — this tolerates
    // the libm/voice-cap artifact (rare, large, isolated) but trips on a real
    // port bug (a wrong note/lane diverges on a broad swath of samples).
    if (d > Math.max(BAD_FLOOR, BAD_REL * Math.abs(native[i]))) {
      bad++; if (firstBad < 0) firstBad = i;
    }
  }
  const rms = Math.sqrt(sumSqDiff / nN);
  const sigRms = Math.sqrt(sumSqSig / nN);
  const nrmse = sigRms > 1e-9 ? rms / sigRms : (rms > 1e-9 ? Infinity : 0);
  const badFrac = nonZero ? bad / nonZero : 0;
  if (process.env.PARITY_DEBUG) {
    const idx = Array.from({ length: nN }, (_, i) => i)
      .sort((a, b) => Math.abs(native[b] - wasm[b]) - Math.abs(native[a] - wasm[a]))
      .slice(0, 8);
    for (const i of idx) {
      const block = Math.floor(i / (2 * BLOCK));
      const ch = (i % (2 * BLOCK)) < BLOCK ? 'L' : 'R';
      const frame = i % BLOCK;
      console.log(`   #${i} blk=${block} ${ch} f=${frame} native=${native[i].toFixed(6)} wasm=${wasm[i].toFixed(6)} d=${Math.abs(native[i]-wasm[i]).toExponential(3)}`);
    }
  }
  const fails = [];
  if (native.length !== wasm.length)
    fails.push(`length ${native.length} (native) vs ${wasm.length} (wasm)`);
  if (nonZero === 0) fails.push('native output all zero (probe produced silence)');
  if (nrmse > MAX_NRMSE)
    fails.push(`NRMSE ${(nrmse * 100).toFixed(3)}% > ${(MAX_NRMSE * 100)}% (systematic divergence)`);
  if (badFrac > MAX_BAD_FRAC)
    fails.push(`disagreeing ${(badFrac * 100).toFixed(3)}% > ${(MAX_BAD_FRAC * 100)}% of nonzero samples (first @${firstBad})`);
  return { genre, fails, maxAbs, rms, nrmse, badFrac, nonZero, total, samples: nN };
}

// --- run ---------------------------------------------------------------------
const tmpRoot = mkdtempSync(join(tmpdir(), 'cspr-parity-pcm-'));
const pcmFile = join(tmpRoot, 'stubs.pcm');
writeStubPcmFile(pcmFile);

let anyFail = false;
console.log(`wasm parity guard — ${NUM_BLOCKS} blocks @ ${SR}/${BLOCK}, NRMSE<${MAX_NRMSE * 100}% bad<${MAX_BAD_FRAC * 100}%\n`);
for (const g of genres) {
  let r;
  try {
    r = await checkGenre(g, pcmFile);
  } catch (e) {
    console.log(`${g.padEnd(13)} ERROR ${e.message}`);
    anyFail = true;
    continue;
  }
  const status = r.fails.length ? 'FAIL' : 'PASS';
  if (r.fails.length) anyFail = true;
  console.log(
    `${g.padEnd(13)} ${status}  NRMSE=${(r.nrmse * 100).toFixed(4)}% ` +
    `bad=${(r.badFrac * 100).toFixed(4)}% maxAbs=${r.maxAbs.toExponential(2)} ` +
    `nonZero=${r.nonZero}/${r.samples} totalFrames=${r.total}`);
  for (const f of r.fails) console.log(`              - ${f}`);
}
console.log(anyFail ? '\nFAIL' : '\nAll genres PASS');
process.exit(anyFail ? 1 : 0);
