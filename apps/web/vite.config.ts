import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
// @ts-expect-error engine-spike helper is plain JS.
import { resolveAudioCacheRoot } from '../engine-spike/scripts/lib/audio-cache-root.mjs';
// @ts-expect-error engine-spike helper is plain JS.
import { prepareNormalizedSource } from '../engine-spike/scripts/lib/audio-normalize.mjs';

// docs/60 Phase 1 step 6 — dev-only middleware that serves the engine-spike
// render fixtures (genre envelopes + the 5 stub oggs) to the /wasm-render listen
// page, WITHOUT copying ~600 KB of JSON per genre into public/. Three endpoints,
// all same-origin (so COEP require-corp is satisfied):
//   /render-demo/index.json            -> { genres: {<g>: [inst files]}, samples }
//   /render-demo/file/<genre>/<name>   -> a song.json / inst-N.json
//   /render-demo/sample/<name>         -> a stub .ogg
const here = fileURLToPath(new URL('.', import.meta.url));
const ENGINE_SPIKE = resolve(here, '../engine-spike');
const GENRE_ROOT = join(ENGINE_SPIKE, 'out/all-genre-render-smoke');
const SAMPLES_DIR = join(ENGINE_SPIKE, 'samples');
const NORMALIZE_CACHE_DIR = resolveAudioCacheRoot({
  envValue: process.env.CASPERAKI_AUDIO_CACHE_ROOT,
  repoLocalFallback: join(ENGINE_SPIKE, '.cache/audio-normalized'),
}).path;
const STUB_OGGS = ['kick.ogg', 'snare.ogg', 'hat.ogg', 'tone.ogg', 'bass-c2.ogg'];
const safeName = (s: string) => /^[A-Za-z0-9._-]+$/.test(s);

// docs/60 Phase 1 finish — the REAL multisample library. Load engine-spike/.env
// (CASPERAKI_SAMPLE_LIBRARY_ROOT) the way prestage-samples.mjs does, so the
// dev-only real-sample endpoints can resolve the manifest's relativePath against
// the on-disk library. Absent => the page only offers the stub-sampled render.
try {
  const envFile = join(ENGINE_SPIKE, '.env');
  if (existsSync(envFile) && !process.env.CASPERAKI_SAMPLE_LIBRARY_ROOT
      && typeof (process as { loadEnvFile?: (p: string) => void }).loadEnvFile === 'function') {
    (process as unknown as { loadEnvFile: (p: string) => void }).loadEnvFile(envFile);
  }
} catch { /* optional — stub-only without it */ }
const LIBRARY_ROOT = process.env.CASPERAKI_SAMPLE_LIBRARY_ROOT;

type PlanAsset = string; // relativePath against LIBRARY_ROOT, or normalized:<relativePath>
type SamplePlan = {
  assets: PlanAsset[];
  tonal: { key: string; asset: number; sliceStart: number; sliceEnd: number }[];
  drums: { key: string; asset: number }[];
  waves: { key: string; asset: number }[];
  // Guitar fret-noise pool: N equal slices of the Default FX sibling (the host
  // doesn't know the file duration, so the browser slices [i/count, (i+1)/count]
  // of the decoded buffer). Keyed by playsample id (decimal), like tonal.
  frets: { key: string; asset: number; index: number; count: number }[];
  // Guitar strum pool: one whole pre-sliced chord/fx mp3 per pool entry, keyed by
  // playsample id (decimal).
  strums: { key: string; asset: number }[];
};

// Mirror of lib/guitar-chord-alias.mjs::engineChordToDiskChord + lib/
// stage-guitar-strums.mjs::chordFileBasename (and the native SampleLibrary.h
// ports of both). The strum pool's per-chord files live under <preset>/chords
// with the accidental spelled per the library's disk convention.
const CHORD_ROOT_TO_DISK: Record<string, string> = {
  'A#': 'Bb', 'B#': 'C', 'C#': 'C#', 'D#': 'Eb', 'E#': 'F', 'F#': 'F#', 'G#': 'Ab',
};
function engineChordToDiskChord(chord: string): string {
  const m = String(chord).match(/^([A-G])([#b])(.*)$/u);
  if (!m) return String(chord);
  const root = `${m[1]}${m[2]}`;
  return `${CHORD_ROOT_TO_DISK[root] ?? root}${m[3]}`;
}
function chordFileBasename(chord: string, pos: string, type: string): string | null {
  const m = String(type).match(/^chord(Long|Short)Strum(Up|Down)$/u);
  if (!m) return null;
  return `${chord} _ Pos ${pos} _ ${m[1]} Strum ${m[2]}.mp3`;
}

// Mirror of native audio/SampleLibrary.h: turn a genre envelope's
// asset-manifest.json (+ inst-N.json) into the id-keyed sample plan the browser
// fetches + decodes. Keys match the Mixer join: tonal slot id / drum lane name /
// "playsample-<id>.ogg". `assets` are unique relativePaths the browser fetches
// once (by index) and decodes; tonal entries are sliced client-side.
function buildSamplePlan(genre: string): SamplePlan {
  const dir = join(GENRE_ROOT, genre);
  const manifest = JSON.parse(readFileSync(join(dir, 'asset-manifest.json'), 'utf-8'));
  const insts = readdirSync(dir)
    .filter((n) => /^inst-\d+\.json$/.test(n))
    .sort((a, b) => parseInt(a.slice(5), 10) - parseInt(b.slice(5), 10))
    .map((n) => {
      try { return JSON.parse(readFileSync(join(dir, n), 'utf-8')); } catch { return {}; }
    });

  const assets: PlanAsset[] = [];
  const assetIndex = (rel: string) => {
    let i = assets.indexOf(rel);
    if (i < 0) { i = assets.length; assets.push(rel); }
    return i;
  };
  const sampleAsset = (sourcePath: string) => `normalized:${sourcePath}`;
  const laneEntry = (name: string) => manifest?.lanes?.[name] ?? manifest?.[name];

  const tonal: SamplePlan['tonal'] = [];
  for (const inst of insts) {
    if (!Array.isArray(inst.samples) || inst.samples.length === 0) continue;
    if (inst.type === 'drums' || inst.type === 'transitionPattern') continue;
    const name = typeof inst.name === 'string' ? inst.name : '';
    if (!name) continue;
    const entry = laneEntry(name);
    if (!entry || entry.status !== 'resolved' || typeof entry.relativePath !== 'string') continue;
    const slots = entry.multisample?.slots;
    if (!Array.isArray(slots)) continue;
    const ai = assetIndex(sampleAsset(entry.relativePath));
    for (const slot of slots) {
      if (slot?.status !== 'resolved' || !slot.slot || slot.slot.id == null) continue;
      const s0 = slot.sliceStart, s1 = slot.sliceEnd;
      if (!(s1 > s0) || s0 < 0) continue;
      tonal.push({ key: String(slot.slot.id), asset: ai, sliceStart: s0, sliceEnd: s1 });
    }
  }

  const drums: SamplePlan['drums'] = [];
  const drumLanes = manifest?.Drums?.lanes;
  if (drumLanes && typeof drumLanes === 'object') {
    for (const [name, e] of Object.entries<Record<string, unknown>>(drumLanes)) {
      if (!e || e.status !== 'resolved' || typeof e.relativePath !== 'string') continue;
      drums.push({ key: name, asset: assetIndex(sampleAsset(e.relativePath)) });
    }
  }

  const waves: SamplePlan['waves'] = [];
  const idToSrc = new Map<number, string>();
  for (const inst of insts) {
    if (inst.type === 'transitionPattern') {
      for (const s of inst.samples ?? [])
        if (s?.id != null && typeof s.sourcePath === 'string' && !idToSrc.has(s.id))
          idToSrc.set(s.id, sampleAsset(s.sourcePath));
      continue;
    }
    if (['transitionSample', 'percussionLoops', 'percussion'].includes(inst.type)
        && inst.id != null && typeof inst.sourcePath === 'string' && !idToSrc.has(inst.id))
      idToSrc.set(inst.id, sampleAsset(inst.sourcePath));
  }
  for (const [id, src] of idToSrc)
    waves.push({ key: `playsample-${id}.ogg`, asset: assetIndex(src) });

  // Guitar fret-noises + strums (docs/60 Phase 1 finish). Mirror native
  // SampleLibrary::loadFretNoises / loadStrums. The chord/fx files live under the
  // manifest's absolute chordsAbsDir/fxAbsDir; convert to a LIBRARY_ROOT-relative
  // path so the existing /render-demo/asset endpoint can serve them.
  const frets: SamplePlan['frets'] = [];
  const strums: SamplePlan['strums'] = [];
  const guitar = manifest?.Guitar;
  const libRoot = LIBRARY_ROOT ? resolve(LIBRARY_ROOT) : '';
  const relToRoot = (abs: string): string | null => {
    if (!libRoot) return null;
    const r = relative(libRoot, abs);
    return r.startsWith('..') ? null : r;
  };
  for (const inst of insts) {
    if (inst.type !== 'acousticGuitars' && inst.type !== 'electricGuitars') continue;

    const fretIds = inst?.fx?.fxFretNoise;
    const fretRel = guitar?.fretNoiseSibling?.relativePath;
    if (Array.isArray(fretIds) && fretIds.length && typeof fretRel === 'string') {
      const ai = assetIndex(sampleAsset(fretRel));
      fretIds.forEach((id: unknown, i: number) => {
        if (typeof id === 'number') frets.push({ key: String(id), asset: ai, index: i, count: fretIds.length });
      });
    }

    const chordsDir = guitar?.chordsAbsDir, fxDir = guitar?.fxAbsDir;
    for (const e of inst?.virtualGuitaristSamples ?? []) {
      if (e?.id == null) continue;
      let abs: string | null = null;
      if (typeof e.fx === 'string' && e.fx) {
        if (typeof fxDir === 'string') abs = join(fxDir, `${e.fx}.mp3`);
      } else if (typeof chordsDir === 'string') {
        const base = chordFileBasename(engineChordToDiskChord(String(e.chord)), String(e.chordPosition), String(e.type));
        if (base) abs = join(chordsDir, base);
      }
      const rel = abs && existsSync(abs) ? relToRoot(abs) : null;
      if (rel) strums.push({ key: String(e.id), asset: assetIndex(sampleAsset(rel)) });
    }
  }

  return { assets, tonal, drums, waves, frets, strums };
}

function renderDemoFixtures(): Plugin {
  return {
    name: 'casperaki-render-demo-fixtures',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url || '').split('?')[0];
        if (!url.startsWith('/render-demo/')) return next();
        try {
          if (url === '/render-demo/index.json') {
            const genres: Record<string, string[]> = {};
            if (existsSync(GENRE_ROOT)) {
              for (const g of readdirSync(GENRE_ROOT)) {
                const dir = join(GENRE_ROOT, g);
                if (!existsSync(join(dir, 'song.json'))) continue;
                genres[g] = readdirSync(dir)
                  .filter((n) => /^inst-\d+\.json$/.test(n))
                  .sort((a, b) => parseInt(a.slice(5), 10) - parseInt(b.slice(5), 10));
              }
            }
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ genres, samples: STUB_OGGS, library: !!LIBRARY_ROOT }));
            return;
          }
          // The real-sample plan for a genre (id -> asset + slice). Built from the
          // envelope's asset-manifest.json; the browser fetches the assets by index.
          const planMatch = url.match(/^\/render-demo\/plan\/([^/]+)$/);
          if (planMatch) {
            const genre = decodeURIComponent(planMatch[1]);
            if (!safeName(genre)) { res.statusCode = 400; res.end('bad request'); return; }
            if (!LIBRARY_ROOT) { res.statusCode = 404; res.end('no library configured'); return; }
            const dir = join(GENRE_ROOT, genre);
            if (!dir.startsWith(GENRE_ROOT) || !existsSync(join(dir, 'asset-manifest.json'))) {
              res.statusCode = 404; res.end('no manifest'); return;
            }
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify(buildSamplePlan(genre)));
            return;
          }
          // A real library asset, addressed by its index in the genre's plan (so
          // filenames with spaces never hit the URL). Resolved against LIBRARY_ROOT
          // and confined to it.
          const assetMatch = url.match(/^\/render-demo\/asset\/([^/]+)\/(\d+)$/);
          if (assetMatch) {
            const genre = decodeURIComponent(assetMatch[1]);
            const idx = parseInt(assetMatch[2], 10);
            if (!safeName(genre)) { res.statusCode = 400; res.end('bad request'); return; }
            if (!LIBRARY_ROOT) { res.statusCode = 404; res.end('no library configured'); return; }
            const plan = buildSamplePlan(genre);
            const rel = plan.assets[idx];
            if (!rel) { res.statusCode = 404; res.end('no such asset'); return; }
            const isNormalized = rel.startsWith('normalized:');
            const libRoot = resolve(LIBRARY_ROOT);
            let p = resolve(libRoot, isNormalized ? rel.slice('normalized:'.length) : rel);
            if (!p.startsWith(libRoot) || !existsSync(p)) { res.statusCode = 404; res.end('not found'); return; }
            if (isNormalized) {
              const norm = prepareNormalizedSource({ sourcePath: p, cacheDir: NORMALIZE_CACHE_DIR });
              if (norm.kind !== 'copy' && norm.kind !== 'transcoded') {
                res.statusCode = 500; res.end(`normalization failed: ${norm.kind}`); return;
              }
              p = norm.preparedPath;
            }
            res.setHeader('content-type', p.endsWith('.ogg') ? 'audio/ogg' : 'audio/mpeg');
            res.end(readFileSync(p));
            return;
          }
          const fileMatch = url.match(/^\/render-demo\/file\/([^/]+)\/([^/]+)$/);
          if (fileMatch) {
            const [, genre, name] = fileMatch.map(decodeURIComponent);
            if (!safeName(genre) || !safeName(name) || !name.endsWith('.json')) {
              res.statusCode = 400; res.end('bad request'); return;
            }
            const p = join(GENRE_ROOT, genre, name);
            if (!p.startsWith(GENRE_ROOT) || !existsSync(p)) { res.statusCode = 404; res.end('not found'); return; }
            res.setHeader('content-type', 'application/json');
            res.end(readFileSync(p));
            return;
          }
          const sampleMatch = url.match(/^\/render-demo\/sample\/([^/]+)$/);
          if (sampleMatch) {
            const name = decodeURIComponent(sampleMatch[1]);
            if (!safeName(name) || !STUB_OGGS.includes(name)) { res.statusCode = 404; res.end('not found'); return; }
            const p = join(SAMPLES_DIR, name);
            if (!existsSync(p)) { res.statusCode = 404; res.end('not found'); return; }
            res.setHeader('content-type', 'audio/ogg');
            res.end(readFileSync(p));
            return;
          }
          res.statusCode = 404; res.end('not found');
        } catch (err) {
          res.statusCode = 500; res.end(String(err));
        }
      });
    },
  };
}

// Vite dev/preview proxies `/api` to the brain (apps/brain default port 16500).
// Override with BRAIN_URL when running both services on non-default ports.
const brainUrl = process.env.BRAIN_URL ?? 'http://127.0.0.1:16500';

// docs/60 Phase 0 — cross-origin isolation headers. COOP:same-origin +
// COEP:require-corp make `crossOriginIsolated` true, the precondition for
// SharedArrayBuffer + WASM threads (Emscripten pthreads) in Phase 3. The
// in-browser render spike (/wasm-tone) and the future WASM engine are served
// from this origin, and the `/api` proxy below is same-origin, so neither is
// blocked. Caveat: require-corp blocks *cross-origin* subresources lacking
// CORP/CORS headers; switch to `credentialless` if a third-party asset breaks.
const crossOriginIsolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

// The browser engine's files keep their names across builds (public/), so a
// browser may hold an old copy. Every URL to them carries this fingerprint of
// their contents (?v=), and the built worker/worklet import the driver with it
// too: a new engine always has a new address.
const ENGINE_FILES = [
  'public/wasm/engine-render.wasm',
  'public/wasm/engine-resolve.js',
  'public/wasm/engine-resolve.wasm',
  'public/wasm/lame.wasm',
  'public/engine/casperaki-engine.js',
  'public/engine/casperaki-audio-files.js',
  'public/worklets/casperaki-render-worklet.js',
  'public/workers/casperaki-meter-worker.js',
];
const engineVersion = (() => {
  const h = createHash('sha256');
  for (const f of ENGINE_FILES) {
    const abs = resolve(fileURLToPath(new URL('.', import.meta.url)), f);
    if (!existsSync(abs)) throw new Error(`engine file missing: ${f} (run wasm/engine/build-wasm.sh and wasm/lame/build-lame-wasm.sh)`);
    h.update(f).update(readFileSync(abs));
  }
  return h.digest('hex').slice(0, 12);
})();

/** Stamp the fingerprint into the built worker's and worklet's driver import. */
function versionEngineImports(): Plugin {
  return {
    name: 'casperaki-engine-version',
    apply: 'build',
    writeBundle(options) {
      const out = options.dir;
      if (!out) throw new Error('casperaki-engine-version: no output dir');
      for (const f of ['workers/casperaki-meter-worker.js', 'worklets/casperaki-render-worklet.js']) {
        const p = join(out, f);
        const src = readFileSync(p, 'utf8');
        let stamped = src.replace("'../engine/casperaki-engine.js'", `'../engine/casperaki-engine.js?v=${engineVersion}'`);
        if (stamped === src) throw new Error(`casperaki-engine-version: no driver import found in ${f}`);
        if (f.startsWith('workers/')) {
          const before = stamped;
          stamped = stamped.replace("'../engine/casperaki-audio-files.js'", `'../engine/casperaki-audio-files.js?v=${engineVersion}'`);
          if (stamped === before) throw new Error(`casperaki-engine-version: no audio-files import found in ${f}`);
        }
        writeFileSync(p, stamped);
      }
    },
  };
}

export default defineConfig({
  define: { __ENGINE_VERSION__: JSON.stringify(engineVersion) },
  plugins: [react(), tailwindcss(), renderDemoFixtures(), versionEngineImports()],
  // The video engine (@casperaki/video/avatar) is a git dependency whose pnpm folder name holds a "#": Rollup cannot
  // resolve its own imports from there, so they come from this app's copies (same versions as the engine's).
  resolve: { dedupe: ['zod', 'three', '@pixiv/three-vrm', 'three-mesh-bvh'] },
  server: {
    port: 5173,
    headers: crossOriginIsolation,
    proxy: {
      '/api': {
        target: brainUrl,
        changeOrigin: true,
      },
      '/healthz': {
        target: brainUrl,
        changeOrigin: true,
      },
    },
  },
  preview: {
    headers: crossOriginIsolation,
  },
});
