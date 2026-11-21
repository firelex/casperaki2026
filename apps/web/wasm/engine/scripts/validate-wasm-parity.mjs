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
// Each genre is checked three ways (dry, mix, seek):
//   dry   — mix off (the Phase-1 path): wasm vs native.
//   mix   — mix on with the shared mix-config.json (= native CASPERAKI_MIX=1:
//           per-lane gains, real velocities, submix + aux-return + master racks):
//           wasm vs native.
//   seek  — wasm only: build, mixer_seek to SEEK_BLOCK, pull the rest; must match
//           the same span of the unseeked render. Mix off seeks with no pre-roll
//           (voices are rebuilt exactly); mix on pre-rolls SEEK_PREROLL_SEC so the
//           FX racks carry the real tail. The mix-on no-pre-roll error is printed
//           for information only (it is what an instant seek costs).
//
// Mix-on checks compare LOUDNESS ENVELOPES, not samples. The TexturizeMS rack
// plugin (keys/synths/drums/fx/... submixes) adds a noise "texture" from a random
// walk whose direction flips on the sign of its input: one last-ULP libm
// difference (native glibc vs wasm musl) near a zero crossing, or any seek (the
// walk's state is the whole song so far), gives a different — statistically
// identical — noise realization. That moves 1-25% of samples past the per-sample
// tolerance while the music is the same; with TexturizeMS removed both mix checks
// match per-sample (NRMSE <= 0.13%, bad <= 0.01%). So mix-on asserts the
// short-time RMS envelope (ENV_WIN frames per window, per channel) agrees to
// MAX_ENV_NRMSE, and prints the per-sample figures for information.
//
// Requires the wasm build: ./build-wasm.sh (engine-render.wasm) and the native
// build: cmake --build build (casperaki_mixer_probe + casperaki_resolve).
// The mix config is CASPERAKI_MIX_CONFIG, else the sibling casperaki_engine repo's.
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
const SEEK_BLOCK = 2067;        // seek point ~6.0 s in (block-aligned)
const SEEK_PREROLL_SEC = 3;     // pre-roll for the mix-on seek
const MIX_CONFIG = process.env.CASPERAKI_MIX_CONFIG
  || '/home/roli79/apps/casperaki_engine/config/mix-config.json';

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
const ENV_WIN = 2048;           // mix-on: RMS window (~46 ms) for the envelope compare
const MAX_ENV_NRMSE = 0.01;     // mix-on: envelope NRMSE limit (observed <= 0.28%; a seek
                                // with no pre-roll, i.e. missing FX tails, reaches 0.6-3.6%)

for (const [bin, hint] of [[PROBE_BIN, 'cmake --build build'], [WASM, './build-wasm.sh'],
                           [MIX_CONFIG, 'set CASPERAKI_MIX_CONFIG to mix-config.json']]) {
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

// --- WASM render of N blocks (optionally mix on, optionally after a seek) -----
// opts: { mix: bool, seekFrame?: number, prerollFrames?: number,
//         meterBin?: number, laneGains?: [lane, gain][] }
async function wasmRender(env, opts = {}) {
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

  const errMsg = () => {
    const p = e.mixer_last_error_message();
    const u8 = new Uint8Array(heap());
    let end = p; while (u8[end] !== 0) end++;
    return new TextDecoder().decode(u8.subarray(p, end));
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

  e.mixer_set_mix_enabled(opts.mix ? 1 : 0);
  if (opts.mix) {
    const cfg = readFileSync(MIX_CONFIG);
    const cfgPtr = writeBytes(cfg);
    const ok = e.mixer_set_mix_config(cfgPtr, cfg.length);
    e.free(cfgPtr);
    if (!ok) throw new Error(`wasm mixer_set_mix_config failed: ${errMsg()}`);
  }

  if (opts.meterBin && !e.mixer_enable_meters(opts.meterBin))
    throw new Error(`wasm mixer_enable_meters failed: ${errMsg()}`);
  const total = e.mixer_build(songPtr, env.song.length, blobPtr, lensPtr, env.insts.length);
  if (e.mixer_last_error() !== 0) throw new Error(`wasm mixer_build failed: ${errMsg()}`);
  for (const [lane, gain] of opts.laneGains ?? [])
    if (!e.mixer_set_lane_gain(lane, gain)) throw new Error(`wasm mixer_set_lane_gain failed: ${errMsg()}`);

  let numBlocks = NUM_BLOCKS;
  let seekMs = 0;
  if (opts.seekFrame !== undefined) {
    const t0 = performance.now();
    const p = e.mixer_seek(opts.seekFrame, opts.prerollFrames ?? 0);
    seekMs = performance.now() - t0;
    if (p !== opts.seekFrame) throw new Error(`wasm mixer_seek returned ${p}: ${errMsg()}`);
    if (e.mixer_position() !== opts.seekFrame) throw new Error('mixer_position != seek frame');
    numBlocks = NUM_BLOCKS - opts.seekFrame / BLOCK;
  }

  const out = new Float32Array(numBlocks * 2 * BLOCK);
  for (let b = 0; b < numBlocks; b++) {
    e.mixer_pull(BLOCK);
    const lPtr = e.mixer_left(), rPtr = e.mixer_right();
    const L = new Float32Array(heap(), lPtr, BLOCK);
    const R = new Float32Array(heap(), rPtr, BLOCK);
    out.set(L, b * 2 * BLOCK);
    out.set(R, b * 2 * BLOCK + BLOCK);
  }
  let lanes;
  if (opts.meterBin) {
    const count = e.mixer_lane_count();
    const bins = Math.min(e.mixer_meter_bin_count(), Math.ceil(numBlocks * BLOCK / opts.meterBin));
    if (count < 0 || bins < 0) throw new Error(`wasm lane/meter query failed: ${errMsg()}`);
    lanes = [];
    for (let l = 0; l < count; l++) {
      const np = e.mixer_lane_name(l), nl = e.mixer_lane_name_length(l);
      if (!np || nl < 0) throw new Error(`wasm mixer_lane_name failed: ${errMsg()}`);
      const name = new TextDecoder().decode(new Uint8Array(heap(), np, nl));
      const peak = Array.from(new Float32Array(heap(), e.mixer_lane_peaks(l), bins));
      const rms = Array.from(new Float32Array(heap(), e.mixer_lane_rms(l), bins));
      lanes.push({ name, peak, rms });
    }
  }
  return { out, total, seekMs, lanes };
}

// --- per-genre compare -------------------------------------------------------
function nativeRender(env, pcmFile, tmp, tag, extraArgs) {
  const nativeRaw = join(tmp, `native-${tag}.raw`);
  execFileSync(PROBE_BIN, [env.dir, pcmFile, String(NUM_BLOCKS), nativeRaw, ...extraArgs],
    { stdio: ['ignore', 'ignore', 'inherit'] });
  const nativeBuf = readFileSync(nativeRaw);
  return new Float32Array(nativeBuf.buffer, nativeBuf.byteOffset, nativeBuf.byteLength / 4);
}

// `native` is the reference, `wasm` the candidate (same block-planar layout).
function compare(native, wasm) {
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
    fails.push(`length ${native.length} (reference) vs ${wasm.length} (candidate)`);
  if (nonZero === 0) fails.push('reference output all zero (silence)');
  if (nrmse > MAX_NRMSE)
    fails.push(`NRMSE ${(nrmse * 100).toFixed(3)}% > ${(MAX_NRMSE * 100)}% (systematic divergence)`);
  if (badFrac > MAX_BAD_FRAC)
    fails.push(`disagreeing ${(badFrac * 100).toFixed(3)}% > ${(MAX_BAD_FRAC * 100)}% of nonzero samples (first @${firstBad})`);
  return { fails, maxAbs, rms, nrmse, badFrac, nonZero, samples: nN };
}

// Short-time RMS envelope compare (mix-on checks; see the header). Inputs are
// block-planar (BLOCK L then BLOCK R per block).
function envelope(buf) {
  const frames = buf.length / 2;
  const nWin = Math.floor(frames / ENV_WIN);
  const env = new Float64Array(nWin * 2);
  for (let i = 0; i < nWin * ENV_WIN; i++) {
    const blk = Math.floor(i / BLOCK), f = i % BLOCK;
    const L = buf[blk * 2 * BLOCK + f], R = buf[blk * 2 * BLOCK + BLOCK + f];
    const w = Math.floor(i / ENV_WIN);
    env[2 * w] += L * L; env[2 * w + 1] += R * R;
  }
  for (let k = 0; k < env.length; k++) env[k] = Math.sqrt(env[k] / ENV_WIN);
  return env;
}

function compareMix(native, wasm) {
  const r = compare(native, wasm);
  const ea = envelope(native), eb = envelope(wasm);
  let d = 0, sig = 0;
  for (let k = 0; k < Math.min(ea.length, eb.length); k++) { d += (ea[k] - eb[k]) ** 2; sig += ea[k] ** 2; }
  const envNrmse = sig > 0 ? Math.sqrt(d / sig) : Infinity;
  const fails = [];
  if (native.length !== wasm.length)
    fails.push(`length ${native.length} (reference) vs ${wasm.length} (candidate)`);
  if (r.nonZero === 0) fails.push('reference output all zero (silence)');
  if (envNrmse > MAX_ENV_NRMSE)
    fails.push(`envelope NRMSE ${(envNrmse * 100).toFixed(3)}% > ${MAX_ENV_NRMSE * 100}%`);
  return { ...r, fails, envNrmse };
}

async function checkGenre(genre, pcmFile) {
  const env = loadEnvelope(genre);
  const tmp = mkdtempSync(join(tmpdir(), `cspr-parity-${genre}-`));
  const seekFrame = SEEK_BLOCK * BLOCK;
  const prerollFrames = SEEK_PREROLL_SEC * SR;
  const tail = (full) => full.subarray(SEEK_BLOCK * 2 * BLOCK);
  const rows = [];

  // Lanes (mix on): names + per-lane meters wasm vs native; meters must not
  // change the audio; a muted lane must meter 0 after the 10 ms ramp.
  {
    const METER_BIN = 1024;
    const metersFile = join(tmp, 'meters.json');
    const nativeOut = nativeRender(env, pcmFile, tmp, 'meters', ['--mix', MIX_CONFIG, '--meters', String(METER_BIN), metersFile]);
    const nat = JSON.parse(readFileSync(metersFile, 'utf-8')).lanes;
    const plain = await wasmRender(env, { mix: true });
    const met = await wasmRender(env, { mix: true, meterBin: METER_BIN });
    const fails = [];
    const names = met.lanes.map((l) => l.name);
    if (names.join('|') !== nat.map((l) => l.name).join('|'))
      fails.push(`lane names differ: wasm [${names.join(', ')}] native [${nat.map((l) => l.name).join(', ')}]`);
    let d = 0, sig = 0;
    met.lanes.forEach((l, i) => {
      for (const key of ['peak', 'rms'])
        l[key].forEach((v, b) => { const r = nat[i]?.[key][b] ?? 0; d += (v - r) ** 2; sig += r * r; });
    });
    const meterNrmse = sig > 0 ? Math.sqrt(d / sig) : Infinity;
    if (meterNrmse > MAX_ENV_NRMSE) fails.push(`meter NRMSE ${(meterNrmse * 100).toFixed(3)}% > ${MAX_ENV_NRMSE * 100}%`);
    let same = plain.out.length === met.out.length;
    for (let i = 0; same && i < plain.out.length; i++) if (plain.out[i] !== met.out[i]) same = false;
    if (!same) fails.push('meters on changed the rendered audio');
    // mute the loudest lane
    const energy = met.lanes.map((l) => l.rms.reduce((a, v) => a + v, 0));
    const loud = energy.indexOf(Math.max(...energy));
    const muted = await wasmRender(env, { mix: true, meterBin: METER_BIN, laneGains: [[loud, 0]] });
    const after = Math.max(...muted.lanes[loud].peak.slice(1));
    if (after !== 0) fails.push(`muted lane "${names[loud]}" still meters ${after} after the ramp`);
    const mutedVsPlain = compare(plain.out, muted.out).nrmse;
    if (!(mutedVsPlain > 0.05)) fails.push(`muting "${names[loud]}" barely changed the master (NRMSE ${(mutedVsPlain * 100).toFixed(2)}%)`);
    rows.push({ check: 'lanes+meters+mute', fails, nrmse: meterNrmse, badFrac: 0, maxAbs: 0,
                nonZero: names.length, samples: nativeOut.length,
                extra: ` lanes=${names.length} meterNRMSE=${(meterNrmse * 100).toFixed(4)}% muted="${names[loud]}" masterΔ=${(mutedVsPlain * 100).toFixed(1)}%` });
  }

  for (const mix of [false, true]) {
    const tag = mix ? 'mix' : 'dry';
    const native = nativeRender(env, pcmFile, tmp, tag, mix ? ['--mix', MIX_CONFIG] : []);
    const full = await wasmRender(env, { mix });
    const cmp = mix ? compareMix : compare;
    rows.push({ check: `${tag} wasm=native`, total: full.total, ...cmp(native, full.out) });

    const pre = mix ? prerollFrames : 0;
    const sk = await wasmRender(env, { mix, seekFrame, prerollFrames: pre });
    rows.push({ check: `${tag} seek pre=${pre / SR}s`, seekMs: sk.seekMs, ...cmp(tail(full.out), sk.out) });
    if (mix) {
      const sk0 = await wasmRender(env, { mix, seekFrame, prerollFrames: 0 });
      rows.push({ check: `${tag} seek pre=0 (info)`, info: true, seekMs: sk0.seekMs,
                  ...compareMix(tail(full.out), sk0.out) });
    }
  }
  return rows;
}

// --- run ---------------------------------------------------------------------
const tmpRoot = mkdtempSync(join(tmpdir(), 'cspr-parity-pcm-'));
const pcmFile = join(tmpRoot, 'stubs.pcm');
writeStubPcmFile(pcmFile);

let anyFail = false;
console.log(`wasm parity guard — ${NUM_BLOCKS} blocks @ ${SR}/${BLOCK}; dry: NRMSE<${MAX_NRMSE * 100}% bad<${MAX_BAD_FRAC * 100}%; ` +
  `mix: envelope NRMSE<${MAX_ENV_NRMSE * 100}% (sample figures informational)\n`);
for (const g of genres) {
  let rows;
  try {
    rows = await checkGenre(g, pcmFile);
  } catch (e) {
    console.log(`${g.padEnd(13)} ERROR ${e.message}`);
    anyFail = true;
    continue;
  }
  for (const r of rows) {
    const status = r.info ? 'INFO' : (r.fails.length ? 'FAIL' : 'PASS');
    if (!r.info && r.fails.length) anyFail = true;
    console.log(
      `${g.padEnd(13)} ${r.check.padEnd(20)} ${status}  NRMSE=${(r.nrmse * 100).toFixed(4)}% ` +
      `bad=${(r.badFrac * 100).toFixed(4)}% maxAbs=${r.maxAbs.toExponential(2)} ` +
      (r.envNrmse !== undefined ? `env=${(r.envNrmse * 100).toFixed(3)}% ` : '') +
      `nonZero=${r.nonZero}/${r.samples}` +
      (r.total !== undefined ? ` totalFrames=${r.total}` : '') +
      (r.seekMs !== undefined ? ` seek=${r.seekMs.toFixed(1)}ms` : '') + (r.extra ?? ''));
    if (!r.info) for (const f of r.fails) console.log(`              - ${f}`);
  }
}
console.log(anyFail ? '\nFAIL' : '\nAll genres PASS');
process.exit(anyFail ? 1 : 0);
