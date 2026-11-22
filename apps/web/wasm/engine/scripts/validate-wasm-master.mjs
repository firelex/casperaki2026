#!/usr/bin/env node
// Matched mastering in the browser build == the native CLI (audio/Matchering.h).
//
//   node scripts/validate-wasm-master.mjs <casperaki_master> <out-dir> <in.wav>...
//
// For each unmastered 24-bit WAV:
//  1. offline: native `casperaki_master in out sergree` vs the wasm master_analyze +
//     master_apply (the Export window's path), written with the same 24-bit rounding;
//     reports the max abs sample difference and the wav-stats-compare.mjs numbers.
//  2. live: the wasm live layer (live_pull with the profile from step 1, from the
//     start, and after a seek), on the same song fed in through a stub mixer whose
//     only sound is that song; compares with the offline master.
// Exit 1 when a difference goes past the tolerances below (rounding / limiter level).
// Requires the wasm build (./build-wasm.sh).
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { instantiateEngine, lastError, masterSong } from '../../../public/engine/casperaki-engine.js';
import { encodeWav24 } from '../../../public/engine/casperaki-audio-files.js';

const here = dirname(fileURLToPath(import.meta.url));
const WASM = resolve(here, '../../../public/wasm/engine-render.wasm');
const [nativeBin, outDir, ...inputs] = process.argv.slice(2);
if (!nativeBin || !outDir || inputs.length === 0) {
  console.error('usage: validate-wasm-master.mjs <casperaki_master> <out-dir> <in.wav>...');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

// Tolerances. Offline: float rounding between glibc and emscripten libm; the NC-17
// limiter's feedback state carries a last-bit difference on for a while, so single
// samples near full scale differ by up to ~1e-3 while the whole stays ~-86 dB below
// the signal. Live from the start: the live stream is fed 4096 frames of silence
// first (the FIR history before frame 0), which only moves the limiter's dither.
// After a seek the limiter state differs (it cannot seek): judged by spectrum.
const MAX_OFFLINE_DIFF = 5e-3;
const MAX_OFFLINE_NRMSE = 1e-3;
const MAX_LIVE_START_DIFF = 1e-3;
const MAX_LIVE_SEEK_LSD_DB = 0.2;
const MAX_LIVE_SEEK_ENV_NRMSE = 0.05;
// After the stand-in -> matched switch the stream starts from the ring (no seek of
// the mixer), so only its limiter state is new: a second later it is at rounding level.
const MAX_LIVE_SWITCH_DIFF = 5e-3;

/** NRMSE of the 50 ms RMS envelopes. */
function envelopeNrmse(a, b) {
  const W = 2205;
  let d = 0, r = 0;
  for (let w = 0; w + W <= Math.min(a.length, b.length); w += W) {
    let ea = 0, eb = 0;
    for (let i = w; i < w + W; i++) { ea += a[i] * a[i]; eb += b[i] * b[i]; }
    ea = Math.sqrt(ea / W); eb = Math.sqrt(eb / W);
    d += (ea - eb) ** 2; r += eb * eb;
  }
  return +Math.sqrt(d / r).toFixed(5);
}

function readWav24(path) {
  const b = readFileSync(path);
  if (b.toString('ascii', 0, 4) !== 'RIFF') throw new Error(`${path}: not RIFF`);
  let off = 12, fmt, data;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4), sz = b.readUInt32LE(off + 4);
    off += 8;
    if (id === 'fmt ') fmt = { ch: b.readUInt16LE(off + 2), sr: b.readUInt32LE(off + 4), bits: b.readUInt16LE(off + 14) };
    else if (id === 'data') { data = { off, sz }; break; }
    off += sz + (sz & 1);
  }
  if (!fmt || !data || fmt.ch !== 2 || fmt.bits !== 24) throw new Error(`${path}: want stereo 24-bit PCM`);
  const frames = Math.floor(data.sz / 6);
  const left = new Float32Array(frames), right = new Float32Array(frames);
  for (let i = 0, o = data.off; i < frames; i++, o += 6) {
    left[i] = b.readIntLE(o, 3) / 8388608;
    right[i] = b.readIntLE(o + 3, 3) / 8388608;
  }
  return { left, right, sampleRate: fmt.sr };
}

function maxAbsDiff(a, b, from = 0, to = Math.min(a.length, b.length)) {
  let m = 0, at = -1;
  for (let i = from; i < to; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > m) { m = d; at = i; }
  }
  return { max: m, at };
}

function stats(a, b) {
  const out = execFileSync('node', [join(here, 'wav-stats-compare.mjs'), a, b, '--json'], { encoding: 'utf8' });
  return JSON.parse(out);
}

const toDb = (x) => (x > 0 ? (20 * Math.log10(x)).toFixed(1) : '-inf');

// --- the live layer, driven like the worklet ---------------------------------
// The live layer needs a mixer, so this check builds one from the ballad fixture
// envelope (stub samples, mix on), masters that mixer's unmastered render offline
// (the reference) and compares the live output, from the start and after a seek.
const FIXTURE = resolve(here, '../../../../engine-spike/out/all-genre-render-smoke/ballad');
const MIX_CONFIG = process.env.CASPERAKI_MIX_CONFIG || '/home/roli79/apps/casperaki_engine/config/mix-config.json';

function fixtureOptions() {
  const files = execFileSync('ls', [FIXTURE], { encoding: 'utf8' }).split('\n');
  const insts = files
    .filter((n) => /^inst-\d+\.json$/.test(n))
    .sort((a, b) => parseInt(a.slice(5), 10) - parseInt(b.slice(5), 10))
    .map((n) => new Uint8Array(readFileSync(join(FIXTURE, n))));
  const stub = (f0) => {
    const pcm = new Float32Array(8000);
    for (let i = 0; i < pcm.length; i++) pcm[i] = Math.fround((1 - i / pcm.length) * 0.6 * Math.sin((2 * Math.PI * f0 * i) / 44100));
    return pcm;
  };
  return {
    sampleRate: 44100,
    song: new Uint8Array(readFileSync(join(FIXTURE, 'song.json'))),
    insts,
    samples: [stub(117), stub(154), stub(191), stub(228), stub(265)],
    realSamples: [],
    mixConfig: new Uint8Array(readFileSync(MIX_CONFIG)),
  };
}

async function checkLive(report) {
  const { buildMixer } = await import('../../../public/engine/casperaki-engine.js');
  const BLOCK = 128;
  // Unmastered render (as the worker does for the profile).
  const off = instantiateEngine(readFileSync(WASM));
  // 128-frame blocks, as the worklet (and the server's casperaki_render) pull: the
  // mix's effects work per block, so another block size is a different render.
  const total = buildMixer(off, { ...fixtureOptions(), blockFrames: BLOCK });
  const left = new Float32Array(total), right = new Float32Array(total);
  for (let pos = 0; pos < total; pos += BLOCK) {
    off.mixer_pull(BLOCK);
    const n = Math.min(BLOCK, total - pos);
    left.set(new Float32Array(off.memory.buffer, off.mixer_left(), n), pos);
    right.set(new Float32Array(off.memory.buffer, off.mixer_right(), n), pos);
  }
  const ref = masterSong(off, left, right, 'sergree');

  const run = (seekFrame, frames) => {
    const e = instantiateEngine(readFileSync(WASM));
    buildMixer(e, { ...fixtureOptions(), blockFrames: BLOCK, liveMastering: true });
    const bytes = ref.profile;
    const p = e.malloc(bytes.length);
    new Uint8Array(e.memory.buffer, p, bytes.length).set(bytes);
    if (e.live_set_profile(p, bytes.length) !== 1) throw new Error(`live_set_profile: ${lastError(e)}`);
    e.free(p);
    const latency = e.live_latency_frames();
    if (seekFrame > 0 && e.live_seek(seekFrame, 1.5 * 44100) !== seekFrame) throw new Error(`live_seek: ${lastError(e)}`);
    if (e.live_position() !== seekFrame) throw new Error(`live_position ${e.live_position()} != ${seekFrame}`);
    const outL = new Float32Array(frames), outR = new Float32Array(frames);
    for (let pos = 0; pos < frames; pos += BLOCK) {
      if (e.live_pull(BLOCK) < 0) throw new Error(`live_pull: ${lastError(e)}`);
      const n = Math.min(BLOCK, frames - pos);
      outL.set(new Float32Array(e.memory.buffer, e.mixer_left(), n), pos);
      outR.set(new Float32Array(e.memory.buffer, e.mixer_right(), n), pos);
    }
    return { left: outL, right: outR, latency };
  };

  // From the start, past the 2048-frame crossfade (which starts from frame 0 here).
  const span = 30 * 44100;
  const live = run(0, span);
  const fromStart = Math.max(maxAbsDiff(live.left, ref.left, 4096, span).max, maxAbsDiff(live.right, ref.right, 4096, span).max);
  // After a seek to 60 s: a 20 s span.
  const seekAt = 60 * 44100;
  const sought = run(seekAt, 20 * 44100);
  const refSpan = { left: ref.left.subarray(seekAt, seekAt + 20 * 44100), right: ref.right.subarray(seekAt, seekAt + 20 * 44100) };
  const seekDiff = Math.max(maxAbsDiff(sought.left, refSpan.left).max, maxAbsDiff(sought.right, refSpan.right).max);
  const a = join(outDir, 'live-seek.wav'), b = join(outDir, 'live-seek-ref.wav');
  writeFileSync(a, encodeWav24(sought.left, sought.right, 44100, 'master'));
  writeFileSync(b, encodeWav24(refSpan.left, refSpan.right, 44100, 'master'));
  const s = stats(b, a);
  // Stand-in first, the profile arriving 5 s in (as in the browser), then a loop.
  {
    const e = instantiateEngine(readFileSync(WASM));
    buildMixer(e, { ...fixtureOptions(), blockFrames: BLOCK, liveMastering: true });
    const frames = 30 * 44100;
    const outL = new Float32Array(frames);
    const switchAt = 5 * 44100 - ((5 * 44100) % BLOCK);
    for (let pos = 0; pos < frames; pos += BLOCK) {
      if (pos === switchAt) {
        const p = e.malloc(ref.profile.length);
        new Uint8Array(e.memory.buffer, p, ref.profile.length).set(ref.profile);
        if (e.live_set_profile(p, ref.profile.length) !== 1) throw new Error(`live_set_profile: ${lastError(e)}`);
        e.free(p);
        if (e.live_matched() !== 1) throw new Error('live_matched is not 1 after the profile');
      }
      if (e.live_position() !== pos) throw new Error(`live_position ${e.live_position()} != ${pos} (the clock moved)`);
      if (e.live_pull(BLOCK) < 0) throw new Error(`live_pull: ${lastError(e)}`);
      outL.set(new Float32Array(e.memory.buffer, e.mixer_left(), Math.min(BLOCK, frames - pos)), pos);
    }
    const after = maxAbsDiff(outL, ref.left, switchAt + 44100, frames).max;
    // The loop 10 s..12 s, set while playing at 30 s (past it), then a seek into it.
    if (e.live_set_loop(10 * 44100, 12 * 44100) !== 1) throw new Error(`live_set_loop: ${lastError(e)}`);
    if (e.live_seek(11 * 44100, 0) < 0) throw new Error(`live_seek: ${lastError(e)}`);
    let wrapped = false, inside = true;
    for (let k = 0; k < (3 * 44100) / BLOCK; k++) {
      const before = e.live_position();
      e.live_pull(BLOCK);
      const now = e.live_position();
      if (now < before) wrapped = true;
      if (now < 10 * 44100 || now > 12 * 44100) inside = false;
    }
    report.push({ check: 'live stand-in -> matched at 5 s, then loop', afterSwitchMaxDiff: after, loopWrapped: wrapped, loopStayedInside: inside });
    if (!(after <= MAX_LIVE_SWITCH_DIFF && wrapped && inside)) return false;
  }
  // The mixer's own seek already changes the mix-on render (effect noise walks and
  // tails restart from the pre-roll): measure that, unmastered, as the yardstick.
  const raw = instantiateEngine(readFileSync(WASM));
  buildMixer(raw, { ...fixtureOptions(), blockFrames: BLOCK });
  if (raw.mixer_seek(seekAt, 1.5 * 44100) !== seekAt) throw new Error(`mixer_seek: ${lastError(raw)}`);
  const rawL = new Float32Array(20 * 44100), rawR = new Float32Array(20 * 44100);
  for (let pos = 0; pos < rawL.length; pos += BLOCK) {
    raw.mixer_pull(BLOCK);
    const n = Math.min(BLOCK, rawL.length - pos);
    rawL.set(new Float32Array(raw.memory.buffer, raw.mixer_left(), n), pos);
    rawR.set(new Float32Array(raw.memory.buffer, raw.mixer_right(), n), pos);
  }
  const c = join(outDir, 'raw-seek.wav'), d = join(outDir, 'raw-seek-ref.wav');
  writeFileSync(c, encodeWav24(rawL, rawR, 44100, 'master'));
  writeFileSync(d, encodeWav24(left.subarray(seekAt, seekAt + rawL.length), right.subarray(seekAt, seekAt + rawL.length), 44100, 'master'));
  const r = stats(d, c);
  report.push({
    check: 'live (ballad fixture, stub samples)', latency: live.latency, fromStartMaxDiff: fromStart,
    seekMaxDiff: seekDiff, seekNrmse: s.nrmse, seekLsdDb: s.logSpectralDistance_dB,
    unmasteredMixerSeekNrmse: r.nrmse, unmasteredMixerSeekLsdDb: r.logSpectralDistance_dB,
  });
  // Sample by sample a mix-on seek is a different (statistically identical) texture,
  // which the matched EQ makes louder; so, like validate-wasm-parity.mjs, the seek is
  // judged on the spectrum and the short-time RMS envelope.
  const envNrmse = envelopeNrmse(sought.left, refSpan.left);
  report[report.length - 1].seekEnvelopeNrmse = envNrmse;
  report[report.length - 1].unmasteredMixerSeekEnvelopeNrmse = envelopeNrmse(rawL, left.subarray(seekAt, seekAt + rawL.length));
  return fromStart <= MAX_LIVE_START_DIFF && s.logSpectralDistance_dB <= MAX_LIVE_SEEK_LSD_DB && envNrmse <= MAX_LIVE_SEEK_ENV_NRMSE;
}

const report = [];
let ok = true;
for (const input of inputs) {
  const name = basename(input, '.wav');
  const nativeOut = join(outDir, `${name}.native.wav`);
  const wasmOut = join(outDir, `${name}.wasm.wav`);
  execFileSync(nativeBin, [input, nativeOut, 'sergree'], { stdio: ['ignore', 'ignore', 'inherit'] });
  const song = readWav24(input);
  if (song.sampleRate !== 44100) throw new Error(`${input}: ${song.sampleRate} Hz`);
  const e = instantiateEngine(readFileSync(WASM));
  const t0 = performance.now();
  const m = masterSong(e, song.left, song.right, 'sergree');
  const ms = performance.now() - t0;
  writeFileSync(wasmOut, encodeWav24(m.left, m.right, 44100, 'master'));
  const nat = readWav24(nativeOut);
  const wasm = readWav24(wasmOut);
  if (nat.left.length !== wasm.left.length) throw new Error(`${name}: length ${wasm.left.length} != native ${nat.left.length}`);
  const d = Math.max(maxAbsDiff(nat.left, wasm.left).max, maxAbsDiff(nat.right, wasm.right).max);
  const s = stats(nativeOut, wasmOut);
  report.push({ check: `offline ${name}`, frames: nat.left.length, wasmMs: Math.round(ms), maxAbsDiff: d, maxAbsDiffDb: toDb(d), nrmse: s.nrmse, lsdDb: s.logSpectralDistance_dB, maxBandDeltaDb: s.maxBandDelta_dB });
  if (!(d <= MAX_OFFLINE_DIFF && s.nrmse <= MAX_OFFLINE_NRMSE)) ok = false;
}
if (!(await checkLive(report))) ok = false;
console.log(JSON.stringify(report, null, 2));
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
