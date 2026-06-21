#!/usr/bin/env node
// Phase 2 spike — pre-stage local OGG samples into the JUCE temp dir so the
// engine's SamplesDownloadTask hits its already-on-disk fast path
// (SamplesDownloadTask.cpp:45 for playSample, SamplesDownloadTask.cpp:97
// for vstSample/load batchRun) and skips the broken async-curl paths.
// The async paths have a use-after-free bug on Linux: run() is invoked
// directly without startThread(), wait(-1) doesn't block, the listener
// is deleted while curl callbacks are still in flight. The ZIP-batch
// path (`vstSample/load/`) used by Bass / Synths has the same shape —
// prestaging `vstsample-<id>.ogg` files makes the batchRun's existsAsFile()
// short-circuit fire (vstIds.size() == 0 → no download, copyVstSampleFiles
// FromCacheIntoFolder populates the FileMap directly).
//
// Reads sample IDs out of the round-trip artefacts under
// `out/brain-roundtrip/` (and, if present, `out/minimal-drums/inst-1.json`)
// and copies the appropriate local OGG into the JUCE temp dir under the
// engine's expected filename prefix.

import { existsSync, mkdirSync, readFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stageMultisampleFamily } from './lib/stage-multisample.mjs';
import { stageDrumKit } from './lib/stage-drums.mjs';
import {
  resolveAudioCacheRoot,
  formatCacheRootLog,
} from './lib/audio-cache-root.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// docs/54i — load engine-spike `.env` (CASPERAKI_SAMPLE_LIBRARY_ROOT,
// CASPERAKI_AUDIO_CACHE_ROOT) before reading process.env. Uses Node's
// built-in env-file loader (Node ≥20.12); silently no-ops when the file
// is absent so the bundled-fixture path still works without setup.
// `.env` is gitignored at the repo root.
const ENV_FILE = resolve(__dirname, '../.env');
if (existsSync(ENV_FILE)) {
  process.loadEnvFile(ENV_FILE);
  console.error(`[prestage] loaded env file: ${ENV_FILE}`);
}
const TEMP_DIR = join(homedir(), '.config', 'CasperakiSpike', 'Temporary');
const SAMPLES = resolve(__dirname, '../samples');
// Per docs/54i: normalisation cache for transcoded real-sample sources.
// Keyed on (abs source path, size, mtime) so re-running prestage with
// the same library is a no-op and the 16 Bass ids share one transcode.
// Resolved out-of-repo so converted audio never lands in tracked
// source paths — see audio-cache-root.mjs for priority order.
const CACHE_ROOT_RESOLUTION = resolveAudioCacheRoot({
  envValue: process.env.CASPERAKI_AUDIO_CACHE_ROOT,
  repoLocalFallback: resolve(__dirname, '../.cache/audio-normalized'),
});
const NORMALIZE_CACHE_DIR = CACHE_ROOT_RESOLUTION.path;
console.error(formatCacheRootLog(CACHE_ROOT_RESOLUTION));
// First real-sample slice (docs/54h): when this env var is set the
// prestage script bridges the resolver-resolved Bass sample into the
// engine's vstsample-<id>.ogg slots instead of using the bundled
// fixture. Keys / Pad continue to use the tone.ogg tunable for now.
const SAMPLE_LIBRARY_ROOT = process.env.CASPERAKI_SAMPLE_LIBRARY_ROOT;

// Drum role → fixture file. Used as the fixture-fallback per role when the
// catalog-driven kit assembly can't supply a real sample. Roles not in this
// map fall back to tone.ogg.
const DRUM_ROLE_TO_FIXTURE = {
  bassDrum1: 'kick.ogg',
  bassDrum2: 'kick.ogg',
  snareDrum1: 'snare.ogg',
  snareDrum2: 'snare.ogg',
  hiHatClosed1: 'hat.ogg',
  hiHatClosed2: 'hat.ogg',
  hiHatOpen: 'hat.ogg',
  hiHatPedal: 'hat.ogg',
};

mkdirSync(TEMP_DIR, { recursive: true });

let staged = 0;

function stageMinimalDrumsFromFixture(path) {
  // Used for the legacy `out/minimal-drums/inst-1.json` fixture only —
  // the brain round-trip's drums go through the catalog-bridged drum kit
  // assembly below.
  if (!existsSync(path)) return;
  const drums = JSON.parse(readFileSync(path, 'utf-8'));
  for (const [role, id] of Object.entries(drums.ids ?? {})) {
    const src = resolve(SAMPLES, DRUM_ROLE_TO_FIXTURE[role] ?? 'tone.ogg');
    const dst = join(TEMP_DIR, `playsample-${id}.ogg`);
    copyFileSync(src, dst);
    console.error(`[prestage] ${role}#${id} ← ${src.split('/').pop()} → ${dst}`);
    staged++;
  }
}

// Phase 2 minimal-drums fixture (only drums) — staged FIRST when present
// so the catalog-bridged kit assembly below can overwrite the same
// playsample-<id>.ogg slots (the legacy fixture shares its drum role
// ids with the brain-roundtrip Drums kit). Without this ordering the
// fixture-only render would overwrite the real catalog drum samples.
stageMinimalDrumsFromFixture(resolve(__dirname, '../out/minimal-drums/inst-1.json'));

// Brain round-trip artefacts (drums = inst-1.json; bass = inst-2.json;
// keys = inst-3.json; pad = inst-4.json).
// docs/56d — accept a `BRAIN_OUT_DIR` env var so the all-genre matrix
// driver can point this script at a per-genre envelope under
// `out/all-genre-render-smoke/<genre>/` without trashing the canonical
// `out/brain-roundtrip/` artefacts. Default unchanged.
const BRAIN_OUT = process.env.BRAIN_OUT_DIR
  ? resolve(process.cwd(), process.env.BRAIN_OUT_DIR)
  : resolve(__dirname, '../out/brain-roundtrip');
const MANIFEST_PATH = resolve(BRAIN_OUT, 'asset-manifest.json');

// Drums: catalog-bridged kit assembly per lane (docs/54j Stage 2).
// Maps each engine drum role → its catalog component family
// (kickDrums / snareDrums / hiHatsClosed / hiHatsOpen / cymbals / toms /
// shakers / clapsSnaps), reads the per-lane resolver verdicts from
// asset-manifest.json#Drums, and stages the real catalog sample (with
// ffmpeg normalisation) into the engine's playsample-<id>.ogg slots.
// Lanes without a resolver verdict fall back to the bundled fixture
// (kick.ogg / snare.ogg / hat.ogg / tone.ogg) so the kit is always
// complete. Every lane decision is logged.
{
  const drumsResult = stageDrumKit({
    instPath: resolve(BRAIN_OUT, 'inst-1.json'),
    manifestPath: MANIFEST_PATH,
    sampleLibraryRoot: SAMPLE_LIBRARY_ROOT,
    fixtureSamplesDir: SAMPLES,
    tempDir: TEMP_DIR,
    normalizeCacheDir: NORMALIZE_CACHE_DIR,
    roleToFixture: DRUM_ROLE_TO_FIXTURE,
  });
  staged += drumsResult.staged;
}
// Per-lane multisample staging (docs/54l + docs/57e). The staging loop
// now walks EVERY emitted tonal inst — anything carrying a `samples[]`
// multisample array — instead of a fixed family list
// [Bass, Keys, Pad, Guitar, Synths, PluckedSynths]. The fixed list
// silently dropped duplicate-family lanes (Synths 2, Synths 3) and
// per-segment add-on lanes: their inst-N.json was emitted with a unique
// wrapper id + sample-id range, but no samples were ever staged, so
// they rendered silent. Each lane is staged by its display name
// (`inst.name`), which keys into `asset-manifest.json#lanes[name]` for
// the resolved catalog source + per-slot timing. Drums (no samples[];
// catalog-bridged kit above), transitions + loops (sourcePath, no
// samples[]; staged below) and Guitar's fret-noise / strum pools
// (staged separately below) are all excluded by the samples[] guard.
{
  const { readdirSync } = await import('node:fs');
  const instFiles = existsSync(BRAIN_OUT)
    ? readdirSync(BRAIN_OUT).filter((f) => /^inst-\d+\.json$/.test(f))
    : [];
  let tonalLanes = 0;
  for (const f of instFiles) {
    let inst;
    try { inst = JSON.parse(readFileSync(resolve(BRAIN_OUT, f), 'utf-8')); }
    catch { continue; }
    if (!inst || !Array.isArray(inst.samples) || inst.samples.length === 0) continue;
    if (inst.type === 'drums') continue; // defensive — drums carry no samples[] anyway
    // transitionPattern (edmSnareDrumRoll) also carries samples[] but is NOT a
    // tonal multisample lane — its two snares are staged in the transition loop
    // below (per-sample sourcePath → playsample-<sample.id>.ogg).
    if (inst.type === 'transitionPattern') continue;
    const laneName = typeof inst.name === 'string' ? inst.name : f;
    // Bass uses the tuned bass fixture as its no-library fallback; every
    // other tonal lane falls back to the generic tone.ogg.
    const fixtureRel = inst.type === 'basses' ? 'bass-c2.ogg' : 'tone.ogg';
    const result = stageMultisampleFamily({
      family: laneName,
      fixtureRel,
      instPath: resolve(BRAIN_OUT, f),
      manifestPath: MANIFEST_PATH,
      sampleLibraryRoot: SAMPLE_LIBRARY_ROOT,
      fixtureSamplesDir: SAMPLES,
      tempDir: TEMP_DIR,
      normalizeCacheDir: NORMALIZE_CACHE_DIR,
    });
    staged += result.staged;
    tonalLanes++;
  }
  console.error(`[prestage] tonal lanes staged: ${tonalLanes}`);
}

// docs/54t — Guitar fxFretNoise pool. The Guitar inst-N.json's
// `fx.fxFretNoise[N]` array lists the playsample ids the engine
// `Guitar.h::createFretNoiseSampler` maps to MIDI notes 0..N-1.
// Brain pattern emits `fretNoise` events with `sounds[0] = <idx>`
// indexing into this array. We slice the catalog's Default FX
// sibling MP3 (33s, 8 distinct hits at 4s intervals — verified via
// per-second RMS scan in docs/54t §"Source structure") into 8 equal
// 4.137s slices via the existing `prepareNormalizedSlice` (54l)
// pipeline. The `Guitar.fretNoiseSibling` block in the asset
// manifest points the prestage at the right MP3 row.
//
// Back-compat: when the manifest doesn't carry a `fretNoiseSibling`
// (e.g. a pre-54t asset manifest, or library not mounted), fall back
// to copying `tone.ogg` over every id — the same dummy approach 54s
// used. The pool is still N entries wide so `createFretNoiseSampler`
// builds the right number of sound zones.
{
  const { readFileSync, copyFileSync } = await import('node:fs');
  const { prepareNormalizedSlice, formatSliceLog } = await import('./lib/audio-slice.mjs');
  try {
    const instJson = JSON.parse(readFileSync(resolve(BRAIN_OUT, 'inst-5.json'), 'utf-8'));
    if (instJson?.type === 'acousticGuitars') {
      const fretIds = (instJson.fx?.fxFretNoise ?? []).filter((x) => typeof x === 'number');
      let manifest;
      try { manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8')); } catch { manifest = undefined; }
      const sibling = manifest?.Guitar?.fretNoiseSibling;
      const sourceRel = sibling?.relativePath;
      const sourceAbs = (SAMPLE_LIBRARY_ROOT && sourceRel)
        ? join(SAMPLE_LIBRARY_ROOT, sourceRel)
        : undefined;
      let realCount = 0;
      let fallbackCount = 0;
      if (sourceAbs && existsSync(sourceAbs) && fretIds.length > 0) {
        // Equal slicing — 8 slices over the 33.097-s Default FX.mp3
        // each contain one hit at the slice start (per the source
        // structure inventory in docs/54t).
        // Probe duration via ffprobe so the slicing scales if a
        // future Default FX duration differs.
        const { execFileSync } = await import('node:child_process');
        let totalDur = 33.0;
        try {
          const out = execFileSync('ffprobe',
            ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', sourceAbs],
            { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
          const v = Number.parseFloat(out);
          if (Number.isFinite(v) && v > 1) totalDur = v;
        } catch {}
        const sliceSec = totalDur / fretIds.length;
        for (let i = 0; i < fretIds.length; i++) {
          const fretId = fretIds[i];
          const startSec = i * sliceSec;
          const endSec = (i + 1) * sliceSec;
          const slice = prepareNormalizedSlice({
            sourcePath: sourceAbs,
            sliceStart: startSec,
            sliceEnd: endSec,
            cacheDir: NORMALIZE_CACHE_DIR,
          });
          console.error(formatSliceLog(slice, sourceAbs, startSec, endSec));
          if (slice.kind === 'transcoded' && slice.preparedPath) {
            const dst = join(TEMP_DIR, `playsample-${fretId}.ogg`);
            copyFileSync(slice.preparedPath, dst);
            console.error(`[prestage] Guitar fxFretNoise#${i} id=${fretId} ← slice [${startSec.toFixed(2)}-${endSec.toFixed(2)}]s → playsample-${fretId}.ogg`);
            realCount++;
            staged++;
          } else {
            const src = resolve(SAMPLES, 'tone.ogg');
            const dst = join(TEMP_DIR, `playsample-${fretId}.ogg`);
            copyFileSync(src, dst);
            console.error(`[prestage] Guitar fxFretNoise#${i} id=${fretId} ← fixture (tone.ogg) — slice prep failed`);
            fallbackCount++;
            staged++;
          }
        }
      } else {
        for (const fretId of fretIds) {
          const src = resolve(SAMPLES, 'tone.ogg');
          const dst = join(TEMP_DIR, `playsample-${fretId}.ogg`);
          copyFileSync(src, dst);
          fallbackCount++;
          staged++;
        }
        if (fretIds.length > 0) {
          const reason = !SAMPLE_LIBRARY_ROOT
            ? 'CASPERAKI_SAMPLE_LIBRARY_ROOT not set'
            : !sibling
            ? 'asset-manifest carries no Guitar.fretNoiseSibling (re-run emit-brain-roundtrip)'
            : !sourceAbs || !existsSync(sourceAbs)
            ? `sibling source missing (${sourceAbs})`
            : 'unknown';
          console.error(`[prestage] Guitar fxFretNoise: ${fretIds.length} dummy slot(s) staged via tone.ogg — ${reason}`);
        }
      }
      console.error(`[prestage] Guitar fxFretNoise pool: ${fretIds.length} slots (real=${realCount}, fixture-fallback=${fallbackCount})`);
    }
  } catch (err) {
    console.error(`[prestage] Guitar fxFretNoise staging error: ${err?.message ?? String(err)}`);
  }
}

// docs/54v — Guitar virtualGuitarist chord-strum pool. The Guitar
// inst-N.json's `virtualGuitaristSamples[]` array lists one entry
// per unique (chord, chordPosition, type) triple the brain
// references. The engine's `Guitar.h::ensureSampleMidiNote`
// (250-322) computes a strum-pool key from the CURRENT chord using
// sharps (via `Note::toString` → `MidiMessage::getMidiNoteName(…,
// useSharps=true)`); the adapter mirrors that by writing the
// brain's chord symbol unchanged into the inst entry.
//
// On disk, the legacy library mixes sharps and flats per
// accidental (verified by directory listing for every preset):
//   A# → Bb,  D# → Eb,  G# → Ab    (file is in flat form)
//   C# → C#,  F# → F#               (file is in sharp form)
//
// We translate the inst entry's chord ROOT through this map BEFORE
// resolving the filename (sample id + inst entry stay unchanged so
// the engine still finds the entry). Missing chord files emit an
// explicit error diagnostic — NO silent fallback (per the docs/54v
// staging policy).
{
  const { readFileSync, existsSync: _exists } = await import('node:fs');
  const { stageGuitarStrums } = await import('./lib/stage-guitar-strums.mjs');
  const { engineChordToDiskChord } = await import('./lib/guitar-chord-alias.mjs');
  try {
    const instJson = JSON.parse(readFileSync(resolve(BRAIN_OUT, 'inst-5.json'), 'utf-8'));
    const isGuitar = instJson?.type === 'acousticGuitars' || instJson?.type === 'electricGuitars';
    if (isGuitar) {
      const strumPool = Array.isArray(instJson.virtualGuitaristSamples)
        ? instJson.virtualGuitaristSamples
        : [];
      let manifest;
      try { manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8')); } catch { manifest = undefined; }
      const chordsAbsDir = manifest?.Guitar?.chordsAbsDir;
      const fxAbsDir = manifest?.Guitar?.fxAbsDir;
      if (strumPool.length === 0) {
        console.error(`[prestage] Guitar strums: 0 entries — brain emitted no virtualGuitarist events`);
      } else if (!chordsAbsDir) {
        console.error(
          `[prestage] Guitar strums: ${strumPool.length} entries but ` +
          `asset-manifest carries no Guitar.chordsAbsDir — staging skipped. ` +
          `Re-run emit-brain-roundtrip with SAMPLE_LIBRARY_ROOT set.`,
        );
      } else if (!_exists(chordsAbsDir)) {
        console.error(`[prestage] Guitar strums: chords folder missing on disk: ${chordsAbsDir} — staging skipped.`);
      } else {
        // Translate chord roots to disk-canonical spelling for the
        // file lookup; inst entries unchanged. fx entries pass
        // through verbatim (the alias is irrelevant for fx).
        const translatedEntries = strumPool.map((e) => ({
          ...e,
          chord: typeof e.fx === 'string' ? e.chord : engineChordToDiskChord(e.chord),
        }));
        const result = stageGuitarStrums({
          entries: translatedEntries,
          chordsAbsDir,
          fxAbsDir: fxAbsDir && _exists(fxAbsDir) ? fxAbsDir : undefined,
          tempDir: TEMP_DIR,
          normalizeCacheDir: NORMALIZE_CACHE_DIR,
        });
        staged += result.realCount;
        console.error(
          `[prestage] Guitar strums: ${result.realCount}/${strumPool.length} staged, ${result.skipped} skipped`,
        );
      }
    }
  } catch (err) {
    console.error(`[prestage] Guitar strums staging error: ${err?.message ?? String(err)}`);
  }
}


// Transition + Loop samples (docs/54p + 54r). Adapter emits
// inst-N.json files with `type='transitionSample'` for each brain-
// emitted transition (53aa) and `type='percussionLoops'` for each
// brain-emitted loop (54r). Each carries `sourcePath` relative to the
// sample library root + the resolved catalog id. We normalise the
// source MP3 → OGG via the existing audio-normalize cache and write
// to playsample-<inst.id>.ogg. One pass over the inst files handles
// both lanes — the engine's SamplesDownloadTask short-circuit fires
// the same way on either.
{
  const { readdirSync } = await import('node:fs');
  const { prepareNormalizedSource, formatNormalizationLog } =
    await import('./lib/audio-normalize.mjs');
  let transitionsStaged = 0;
  let transitionsSkipped = 0;
  let loopsStaged = 0;
  let loopsSkipped = 0;
  if (existsSync(BRAIN_OUT) && SAMPLE_LIBRARY_ROOT) {
    for (const f of readdirSync(BRAIN_OUT)) {
      if (!f.startsWith('inst-') || !f.endsWith('.json')) continue;
      let inst;
      try { inst = JSON.parse(readFileSync(resolve(BRAIN_OUT, f), 'utf-8')); }
      catch { continue; }
      // transitionPattern (edmSnareDrumRoll) carries a `samples[]` array (two
      // snares), each with its own `sourcePath` + playsample `id`. Stage each
      // one to playsample-<sample.id>.ogg (docs/54n; engine TransitionPattern.h
      // downloads samples[].id).
      if (inst?.type === 'transitionPattern') {
        const samples = Array.isArray(inst.samples) ? inst.samples : [];
        for (const s of samples) {
          const psrc = s?.sourcePath ? join(SAMPLE_LIBRARY_ROOT, s.sourcePath) : null;
          if (!psrc || !existsSync(psrc)) {
            console.error(`[prestage] transitionPattern ${f} (${inst.name}/sample id=${s?.id}): source MISSING (${psrc})`);
            transitionsSkipped++;
            continue;
          }
          const pnorm = prepareNormalizedSource({ sourcePath: psrc, cacheDir: NORMALIZE_CACHE_DIR });
          console.error(formatNormalizationLog(pnorm, psrc));
          if (pnorm.kind !== 'copy' && pnorm.kind !== 'transcoded') {
            console.error(`[prestage] transitionPattern ${f}: normalization failed (kind=${pnorm.kind})`);
            transitionsSkipped++;
            continue;
          }
          copyFileSync(pnorm.preparedPath, join(TEMP_DIR, `playsample-${s.id}.ogg`));
          console.error(`[prestage] transitionPattern ${f} (${inst.name}/sample id=${s.id}) ← ${psrc.split('/').pop()} → playsample-${s.id}.ogg`);
          transitionsStaged++;
          staged++;
        }
        continue;
      }
      const isTransition = inst?.type === 'transitionSample';
      const isLoop = inst?.type === 'percussionLoops' || inst?.type === 'percussion';
      if (!isTransition && !isLoop) continue;
      const label = isLoop ? 'loop' : 'transition';
      const src = inst.sourcePath ? join(SAMPLE_LIBRARY_ROOT, inst.sourcePath) : null;
      if (!src || !existsSync(src)) {
        console.error(`[prestage] ${label} ${f} (${inst.name}): source MISSING (${src})`);
        if (isLoop) loopsSkipped++; else transitionsSkipped++;
        continue;
      }
      const norm = prepareNormalizedSource({ sourcePath: src, cacheDir: NORMALIZE_CACHE_DIR });
      console.error(formatNormalizationLog(norm, src));
      if (norm.kind !== 'copy' && norm.kind !== 'transcoded') {
        console.error(`[prestage] ${label} ${f}: normalization failed (kind=${norm.kind})`);
        if (isLoop) loopsSkipped++; else transitionsSkipped++;
        continue;
      }
      const dst = join(TEMP_DIR, `playsample-${inst.id}.ogg`);
      copyFileSync(norm.preparedPath, dst);
      console.error(`[prestage] ${label} ${f} (${inst.name}/id=${inst.id}) ← ${src.split('/').pop()} → playsample-${inst.id}.ogg`);
      if (isLoop) loopsStaged++;
      else transitionsStaged++;
      staged++;
    }
  }
  console.error(`[prestage] transitions: ${transitionsStaged} staged, ${transitionsSkipped} skipped`);
  console.error(`[prestage] loops: ${loopsStaged} staged, ${loopsSkipped} skipped`);
}

console.error(`[prestage] ${staged} sample file(s) staged in ${TEMP_DIR}`);
