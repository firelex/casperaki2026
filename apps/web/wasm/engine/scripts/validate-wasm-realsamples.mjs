#!/usr/bin/env node
// WASM real-sample path smoke guard (docs/60 Phase 1 finish).
//
//   node scripts/validate-wasm-realsamples.mjs [genre]
//
// The parity guard (validate-wasm-parity.mjs) proves the wasm mix MATH matches
// native on stub PCM. This guard exercises the NEW browser real-sample ABI that
// stub run can't reach: it builds the genre's sample plan the way the vite
// middleware does, decodes each real library asset with ffmpeg (the headless
// stand-in for the browser's decodeAudioData), slices the tonal slots, pushes
// every sample into the wasm mixer by id via mixer_set_sample_id, and asserts the
// resulting render is finite, non-silent, and MATERIALLY different from the
// stub-only render (i.e. the real samples actually took effect through the join).
//
// Gated on the real library + ffmpeg: without CASPERAKI_SAMPLE_LIBRARY_ROOT (env
// or apps/engine-spike/.env) or ffmpeg on PATH, it SKIPs (exit 0) so CI without
// the Dropbox library stays green. Requires the wasm build (./build-wasm.sh).
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as presolve, relative as prelative, join } from 'node:path';
import { resolveAudioCacheRoot } from '../../../../engine-spike/scripts/lib/audio-cache-root.mjs';
import { prepareNormalizedSource } from '../../../../engine-spike/scripts/lib/audio-normalize.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const engineDir = presolve(here, '..');
const WASM = presolve(engineDir, '../../public/wasm/engine-render.wasm');
const GENRE_ROOT = presolve(engineDir, '../../../engine-spike/out/all-genre-render-smoke');
const ENGINE_SPIKE = presolve(engineDir, '../../../engine-spike');
const NORMALIZE_CACHE_DIR = resolveAudioCacheRoot({
  envValue: process.env.CASPERAKI_AUDIO_CACHE_ROOT,
  repoLocalFallback: presolve(ENGINE_SPIKE, '.cache/audio-normalized'),
}).path;

const SR = 44100, BLOCK = 128, NUM_BLOCKS = 3000;
const only = process.argv[2];
const genres = only ? [only] : ['ballad', 'brightPop', 'urban'];

// --- library root (env, else engine-spike/.env) ------------------------------
let LIBRARY_ROOT = process.env.CASPERAKI_SAMPLE_LIBRARY_ROOT;
if (!LIBRARY_ROOT) {
  try {
    const envFile = join(ENGINE_SPIKE, '.env');
    if (existsSync(envFile)) {
      const m = readFileSync(envFile, 'utf-8').match(/^CASPERAKI_SAMPLE_LIBRARY_ROOT=(.*)$/m);
      if (m) LIBRARY_ROOT = m[1].trim().replace(/^["']|["']$/g, '');
    }
  } catch { /* ignore */ }
}
function haveFfmpeg() {
  try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; }
}
if (!LIBRARY_ROOT || !haveFfmpeg() || !existsSync(WASM)) {
  console.log('SKIP validate-wasm-realsamples: ' +
    (!existsSync(WASM) ? 'no engine-render.wasm (./build-wasm.sh)'
      : !LIBRARY_ROOT ? 'no CASPERAKI_SAMPLE_LIBRARY_ROOT' : 'no ffmpeg on PATH'));
  process.exit(0);
}

// --- sample plan (mirror of vite buildSamplePlan / native SampleLibrary) ------
function buildPlan(genre) {
  const dir = join(GENRE_ROOT, genre);
  const manifest = JSON.parse(readFileSync(join(dir, 'asset-manifest.json'), 'utf-8'));
  const insts = readdirSync(dir).filter((n) => /^inst-\d+\.json$/.test(n))
    .sort((a, b) => parseInt(a.slice(5)) - parseInt(b.slice(5)))
    .map((n) => { try { return JSON.parse(readFileSync(join(dir, n), 'utf-8')); } catch { return {}; } });
  const assets = []; const ai = (r) => { let i = assets.indexOf(r); if (i < 0) { i = assets.length; assets.push(r); } return i; };
  const sampleAsset = (sourcePath) => `normalized:${sourcePath}`;
  const lane = (name) => manifest?.lanes?.[name] ?? manifest?.[name];
  const tonal = [], drums = [], waves = [];
  for (const inst of insts) {
    if (!Array.isArray(inst.samples) || !inst.samples.length) continue;
    if (inst.type === 'drums' || inst.type === 'transitionPattern') continue;
    const e = lane(inst.name);
    if (!e || e.status !== 'resolved' || typeof e.relativePath !== 'string' || !Array.isArray(e.multisample?.slots)) continue;
    const a = ai(sampleAsset(e.relativePath));
    for (const s of e.multisample.slots) {
      if (s?.status !== 'resolved' || s.slot?.id == null || !(s.sliceEnd > s.sliceStart)) continue;
      tonal.push({ key: String(s.slot.id), asset: a, sliceStart: s.sliceStart, sliceEnd: s.sliceEnd });
    }
  }
  const dl = manifest?.Drums?.lanes;
  if (dl) for (const [name, e] of Object.entries(dl))
    if (e && e.status === 'resolved' && typeof e.relativePath === 'string') drums.push({ key: name, asset: ai(sampleAsset(e.relativePath)) });
  const idToSrc = new Map();
  for (const inst of insts) {
    if (inst.type === 'transitionPattern') { for (const s of inst.samples ?? []) if (s?.id != null && s.sourcePath && !idToSrc.has(s.id)) idToSrc.set(s.id, sampleAsset(s.sourcePath)); continue; }
    if (['transitionSample', 'percussionLoops', 'percussion'].includes(inst.type) && inst.id != null && inst.sourcePath && !idToSrc.has(inst.id)) idToSrc.set(inst.id, sampleAsset(inst.sourcePath));
  }
  for (const [id, src] of idToSrc) waves.push({ key: `playsample-${id}.ogg`, asset: ai(src) });

  // Guitar fret-noises + strums (mirror native SampleLibrary::loadFretNoises /
  // loadStrums + vite buildSamplePlan). chord/fx files live under the manifest's
  // absolute chordsAbsDir/fxAbsDir; relativise against LIBRARY_ROOT for decodeAsset.
  const frets = [], strums = [];
  const guitar = manifest?.Guitar;
  const libRoot = presolve(LIBRARY_ROOT);
  const relToRoot = (abs) => { const r = prelative(libRoot, abs); return r.startsWith('..') ? null : r; };
  for (const inst of insts) {
    if (inst.type !== 'acousticGuitars' && inst.type !== 'electricGuitars') continue;
    const fretIds = inst?.fx?.fxFretNoise, fretRel = guitar?.fretNoiseSibling?.relativePath;
    if (Array.isArray(fretIds) && fretIds.length && typeof fretRel === 'string') {
      const a = ai(sampleAsset(fretRel));
      fretIds.forEach((id, i) => { if (typeof id === 'number') frets.push({ key: String(id), asset: a, index: i, count: fretIds.length }); });
    }
    const chordsDir = guitar?.chordsAbsDir, fxDir = guitar?.fxAbsDir;
    for (const e of inst?.virtualGuitaristSamples ?? []) {
      if (e?.id == null) continue;
      let abs = null;
      if (typeof e.fx === 'string' && e.fx) { if (typeof fxDir === 'string') abs = join(fxDir, `${e.fx}.mp3`); }
      else if (typeof chordsDir === 'string') { const b = chordFileBasename(engineChordToDiskChord(String(e.chord)), String(e.chordPosition), String(e.type)); if (b) abs = join(chordsDir, b); }
      const rel = abs && existsSync(abs) ? relToRoot(abs) : null;
      if (rel) strums.push({ key: String(e.id), asset: ai(sampleAsset(rel)) });
    }
  }
  return { dir, assets, tonal, drums, waves, frets, strums };
}

// Mirror of lib/guitar-chord-alias.mjs + lib/stage-guitar-strums.mjs (+ native).
const CHORD_ROOT_TO_DISK = { 'A#': 'Bb', 'B#': 'C', 'C#': 'C#', 'D#': 'Eb', 'E#': 'F', 'F#': 'F#', 'G#': 'Ab' };
function engineChordToDiskChord(chord) {
  const m = String(chord).match(/^([A-G])([#b])(.*)$/u);
  if (!m) return String(chord);
  return `${CHORD_ROOT_TO_DISK[`${m[1]}${m[2]}`] ?? `${m[1]}${m[2]}`}${m[3]}`;
}
function chordFileBasename(chord, pos, type) {
  const m = String(type).match(/^chord(Long|Short)Strum(Up|Down)$/u);
  return m ? `${chord} _ Pos ${pos} _ ${m[1]} Strum ${m[2]}.mp3` : null;
}

// Decode a whole asset to mono float32 @ SR via ffmpeg (browser decodeAudioData
// stand-in). Slicing is done in JS by sample offset, matching the native path.
function decodeAsset(rel) {
  let abs = join(LIBRARY_ROOT, rel.startsWith('normalized:') ? rel.slice('normalized:'.length) : rel);
  if (rel.startsWith('normalized:')) {
    const norm = prepareNormalizedSource({ sourcePath: abs, cacheDir: NORMALIZE_CACHE_DIR });
    if (norm.kind !== 'copy' && norm.kind !== 'transcoded')
      throw new Error(`normalization failed for ${abs}: ${norm.kind}`);
    abs = norm.preparedPath;
  }
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', abs, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'],
    { maxBuffer: 1 << 30 });
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
}

function applyTracktionSamplerFade(pcm) {
  if (!pcm || pcm.length === 0 || Math.abs(pcm[0]) <= 0.01) return pcm;
  const out = pcm.slice();
  const fadeLen = Math.min(30, out.length);
  const step = (Math.PI / 2) / fadeLen;
  for (let i = 0; i < fadeLen; i++) out[i] *= 1 - Math.cos(i * step);
  return out;
}

// --- wasm render -------------------------------------------------------------
function smoothStub(role) {
  const N = 8000, pcm = new Float32Array(N), f0 = 80 + role * 37;
  for (let i = 0; i < N; i++) pcm[i] = Math.fround((1 - i / N) * (0.6 * Math.sin(2 * Math.PI * f0 * i / SR) + 0.3 * Math.sin(2 * Math.PI * 2 * f0 * i / SR)));
  return pcm;
}

async function renderWasm(plan, real) {
  const mod = await WebAssembly.compile(readFileSync(WASM));
  const inst = await WebAssembly.instantiate(mod, {
    wasi_snapshot_preview1: { fd_close: () => 0, fd_write: () => 0, fd_seek: () => 0, environ_sizes_get: () => 0, environ_get: () => 0 },
    env: { emscripten_notify_memory_growth: () => {} },
  });
  const e = inst.exports;
  if (typeof e._initialize === 'function') e._initialize();
  const enc = new TextEncoder();
  const heap = () => e.memory.buffer;
  const writeF = (f) => { const p = e.malloc(f.byteLength); new Float32Array(heap(), p, f.length).set(f); return p; };

  e.mixer_config(SR, BLOCK);
  for (let role = 0; role < 5; role++) { const pcm = smoothStub(role + 1); const p = writeF(pcm); e.mixer_set_sample(role, p, 0, pcm.length, 1, SR); e.free(p); }

  if (real) {
    const decoded = plan.assets.map((rel) => decodeAsset(rel));
    const push = (key, pcm) => {
      const kb = enc.encode(key); const kp = e.malloc(kb.length); const pp = e.malloc(pcm.byteLength);
      new Uint8Array(heap(), kp, kb.length).set(kb); new Float32Array(heap(), pp, pcm.length).set(pcm);
      e.mixer_set_sample_id(kp, kb.length, pp, 0, pcm.length, 1, SR); e.free(kp); e.free(pp);
    };
    for (const t of plan.tonal) {
      const d = decoded[t.asset]; const from = Math.max(0, Math.round(t.sliceStart * SR)), to = Math.min(d.length, Math.round(t.sliceEnd * SR));
      if (to > from) push(t.key, applyTracktionSamplerFade(d.slice(from, to)));
    }
    for (const w of plan.drums) push(w.key, applyTracktionSamplerFade(decoded[w.asset]));
    for (const w of plan.waves) push(w.key, decoded[w.asset]);
    for (const f of plan.frets ?? []) {
      const d = decoded[f.asset]; if (!d || f.count <= 0) continue;
      const from = Math.max(0, Math.round((f.index / f.count) * d.length)), to = Math.min(d.length, Math.round(((f.index + 1) / f.count) * d.length));
      if (to > from) push(f.key, applyTracktionSamplerFade(d.slice(from, to)));
    }
    for (const s of plan.strums ?? []) push(s.key, applyTracktionSamplerFade(decoded[s.asset]));
  }

  const dir = plan.dir;
  const song = readFileSync(join(dir, 'song.json'));
  const instFiles = readdirSync(dir).filter((n) => /^inst-\d+\.json$/.test(n)).sort((a, b) => parseInt(a.slice(5)) - parseInt(b.slice(5))).map((n) => readFileSync(join(dir, n)));
  const songPtr = (() => { const p = e.malloc(song.length); new Uint8Array(heap(), p, song.length).set(song); return p; })();
  const blob = Buffer.concat(instFiles); const blobPtr = (() => { const p = e.malloc(blob.length); new Uint8Array(heap(), p, blob.length).set(blob); return p; })();
  const lens = new Int32Array(instFiles.map((b) => b.length)); const lensPtr = e.malloc(lens.byteLength); new Int32Array(heap(), lensPtr, lens.length).set(lens);
  const total = e.mixer_build(songPtr, song.length, blobPtr, lensPtr, instFiles.length);
  if (e.mixer_last_error() !== 0) throw new Error('mixer_build failed');

  const out = new Float32Array(NUM_BLOCKS * 2 * BLOCK);
  for (let b = 0; b < NUM_BLOCKS; b++) {
    e.mixer_pull(BLOCK);
    out.set(new Float32Array(heap(), e.mixer_left(), BLOCK), b * 2 * BLOCK);
    out.set(new Float32Array(heap(), e.mixer_right(), BLOCK), b * 2 * BLOCK + BLOCK);
  }
  return { out, total };
}

// --- run ---------------------------------------------------------------------
let anyFail = false;
console.log(`wasm real-sample smoke — ${NUM_BLOCKS} blocks @ ${SR}/${BLOCK}\n`);
for (const g of genres) {
  try {
    const plan = buildPlan(g);
    const real = await renderWasm(plan, true);
    const stub = await renderWasm(plan, false);
    let nz = 0, nan = 0, sumSqDiff = 0, sumSqStub = 0;
    for (let i = 0; i < real.out.length; i++) {
      const r = real.out[i];
      if (!Number.isFinite(r)) nan++;
      if (Math.abs(r) > 1e-4) nz++;
      const d = r - stub.out[i]; sumSqDiff += d * d; sumSqStub += stub.out[i] * stub.out[i];
    }
    const nzFrac = nz / real.out.length;
    const diffRms = Math.sqrt(sumSqDiff / real.out.length);
    const stubRms = Math.sqrt(sumSqStub / real.out.length);
    const relDiff = stubRms > 1e-9 ? diffRms / stubRms : Infinity;
    const fails = [];
    if (nan > 0) fails.push(`${nan} non-finite samples`);
    if (nzFrac < 0.05) fails.push(`near-silent (${(nzFrac * 100).toFixed(2)}% nonzero)`);
    if (relDiff < 0.2) fails.push(`real ≈ stub (relDiff ${(relDiff * 100).toFixed(1)}% < 20% — real samples not applied?)`);
    const status = fails.length ? 'FAIL' : 'PASS';
    if (fails.length) anyFail = true;
    console.log(`${g.padEnd(13)} ${status}  plan: ${plan.assets.length} assets / ${plan.tonal.length} tonal / ${plan.drums.length} drums / ${plan.waves.length} waves · nonzero=${(nzFrac * 100).toFixed(1)}% relDiff(real,stub)=${(relDiff * 100).toFixed(0)}%`);
    for (const f of fails) console.log(`              - ${f}`);
  } catch (err) {
    console.log(`${g.padEnd(13)} ERROR ${err.message}`); anyFail = true;
  }
}
console.log(anyFail ? '\nFAIL' : '\nAll genres PASS');
process.exit(anyFail ? 1 : 0);
