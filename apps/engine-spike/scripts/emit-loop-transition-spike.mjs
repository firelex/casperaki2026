#!/usr/bin/env node
// docs/54o — Loop + TransitionSample + Drum fills render spike.
//
// Builds a SELF-CONTAINED engine envelope under `out/loop-transition-spike/`
// proving THREE previously-unproven audio lanes (see docs/54n):
//
//   1. Loop.h — percussion loop on a verse segment.
//   2. TransitionSample.h — cymbalsCrashHit firing at chorus1 onset.
//   3. Drums.h::applyFill — per-segment-slot fill pass-through.
//
// All three are exercised IN ONE WAV so cross-lane interference (e.g. the
// loop muting the transition, or fills clobbering the loop) is also
// covered.
//
// Tempo: 100 bpm. Picked specifically because percussionLoops
// `_90-119bpm` rows are 100% on-disk and the brightPop subset has bpm=100
// rows (3 candidates). The brain-roundtrip-vertical-slice's 120 bpm
// can't be matched today (the `_120-150bpm` rows are audit-vs-disk-stale
// — see docs/54n §1).
//
// Segments (at 100 bpm):
//   verse1   8 bars × 4 beats × 0.6s/beat = 19.2s (t=0..19.2s)
//      - Drums.bassDrum1 on beats 1+3, snareDrum1 on 2+4
//      - Loop active across whole segment (Shaker Tamb2 100bpm_modified)
//      - Fill on the last bar (patternEndOfSegment clap pattern)
//   chorus1  4 bars × 4 beats × 0.6s/beat = 9.6s  (t=19.2..28.8s)
//      - Drums same kick/snare pattern
//      - cymbalsCrashHit transition at segment start (climax=0 → start position=0)
//      - Loop INACTIVE (so we can hear loop-on → loop-off contrast)

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadValidatedCatalog, resolveAssetPath } from '@casperaki/arrangement';

import { prepareNormalizedSource, formatNormalizationLog } from './lib/audio-normalize.mjs';
import { resolveAudioCacheRoot, formatCacheRootLog } from './lib/audio-cache-root.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SAMPLES = resolve(ROOT, 'samples');
const TEMP_DIR = join(homedir(), '.config', 'CasperakiSpike', 'Temporary');
const OUT = resolve(ROOT, 'out/loop-transition-spike');

const ENV_FILE = resolve(__dirname, '../.env');
if (existsSync(ENV_FILE)) {
  process.loadEnvFile(ENV_FILE);
  console.error(`[lts-spike] loaded env: ${ENV_FILE}`);
}
const SAMPLE_LIBRARY_ROOT = process.env.CASPERAKI_SAMPLE_LIBRARY_ROOT;
const CACHE_RES = resolveAudioCacheRoot({
  envValue: process.env.CASPERAKI_AUDIO_CACHE_ROOT,
  repoLocalFallback: resolve(__dirname, '../.cache/audio-normalized'),
});
console.error(formatCacheRootLog(CACHE_RES));
if (!SAMPLE_LIBRARY_ROOT) {
  console.error('[lts-spike] CASPERAKI_SAMPLE_LIBRARY_ROOT not set — aborting');
  process.exit(2);
}

mkdirSync(OUT, { recursive: true });
mkdirSync(TEMP_DIR, { recursive: true });

// ---- 1. Pick catalog rows -----------------------------------------------
const catalog = loadValidatedCatalog();

const LOOP_CATALOG_ID = 'ab4c1b66a7fc418c'; // Shaker Tamb2 100bpm (brightPop, _90-119bpm, on-disk verified)
const loopEntry = catalog.byId.get(LOOP_CATALOG_ID);
if (!loopEntry) throw new Error('loop catalog row not in validated catalog');
const loopRel = loopEntry.matchedPath;
const loopAbs = join(SAMPLE_LIBRARY_ROOT, loopRel);
if (!existsSync(loopAbs)) throw new Error(`loop file missing: ${loopAbs}`);

// Pick a brightPop cymbalsCrashHit. Sort by id for determinism.
const crashRows = catalog.entries
  .filter((e) => e.family === 'cymbals' && e.lowLevel === 'cymbalsCrashHit' &&
                 (e.mainStyle === 'brightPop' || (e.addStyles || []).includes('brightPop')))
  .sort((a, b) => (a.id < b.id ? -1 : 1));
if (crashRows.length === 0) throw new Error('no brightPop cymbalsCrashHit row');
const crashEntry = crashRows[0];
const crashRel = crashEntry.matchedPath;
const crashAbs = join(SAMPLE_LIBRARY_ROOT, crashRel);
if (!existsSync(crashAbs)) throw new Error(`crash file missing: ${crashAbs}`);

console.error(`[lts-spike] loop:  ${loopEntry.preset} (${loopEntry.id})  → ${loopRel.split('/').pop()}`);
console.error(`[lts-spike] crash: ${crashEntry.preset} (${crashEntry.id}) → ${crashRel.split('/').pop()}`);

// ---- 2. Probe durations + climax via ffprobe ----------------------------
function ffprobeSeconds(path) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  return Number.parseFloat(out);
}
const loopDuration = ffprobeSeconds(loopAbs);
const crashDuration = ffprobeSeconds(crashAbs);
console.error(`[lts-spike] loop duration:  ${loopDuration.toFixed(3)}s`);
console.error(`[lts-spike] crash duration: ${crashDuration.toFixed(3)}s`);

// ---- 3. Build engine envelope -------------------------------------------
const TEMPO = 100;
const SONG_KEY = 'C';
const beatSec = 60 / TEMPO;
const barSec = beatSec * 4;
const VERSE_BARS = 8;
const CHORUS_BARS = 4;

// Sample id space: must not collide with the brain-roundtrip baseline.
// Drums uses 26929-27770. Bass 945-960. Keys 2048-2064. Pad 3153-3169.
// Guitar 5000-5029, fret-noise 5100, strums 5200-5202. Use 6000+ here.
const LOOP_INST_VST_ID = 38940;       // arbitrary, matches Phase 2 Loop fixture style
const LOOP_PLAYSAMPLE_ID = 6000;       // for playsample-<id>.ogg

const CRASH_INST_VST_ID = 38941;
const CRASH_PLAYSAMPLE_ID = 6001;

// Fill: a small "clap" hit on each 8th note across the last bar of verse1.
// Drums::applyFill (Drums.h:128) consumes `patternEndOfSegment` → places
// the fill on the LAST bar of the segment. The grid is per-32nd-note
// ASCII (x|0|-). 32 chars = 1 bar.
const FILL_GRID = 'x000x000x000x000x000x000x000x000';

// Drum override: kick on 1+3, snare on 2+4 — same throughout verse1 + chorus1.
const DRUM_PATTERN = {
  bassDrum1:   '0000000000000000x000000000000000', // wait — we want kick on beats 1+3 of a 32nd-note grid
  snareDrum1:  '00000000x000000000000000x0000000', // snare on 2+4
  hiHatClosed1:'x000x000x000x000x000x000x000x000', // hat every 8th
};
// Correct bassDrum1 — beats 1 (slot 0) + 3 (slot 16):
DRUM_PATTERN.bassDrum1 = 'x000000000000000x000000000000000';

const drumsOverride = (segName) => ({
  Drums: { type: 'spike', pattern: { ...DRUM_PATTERN } },
});

// fills block: brain's 53aa shape — { reset: false, patterns: { patternEndOfSegment: { clap: <grid> } } }
const VERSE_FILLS = {
  Drums: {
    reset: false,
    patterns: {
      patternEndOfSegment: { clap: FILL_GRID },
    },
  },
};

// Transition data: cymbalsCrashHit at climax=0 → startPosition32 = 0, duration = source seconds.
// Sequencer.cpp's getTransitionSegmentData looks up arrangement[seg].transitions.<inst-display-name>.
// inst display name: we use the catalog row's `lowLevel` ("cymbalsCrashHit") as the engine inst name.
const CRASH_INST_NAME = 'cymbalsCrashHit';
const chorusTransitions = {
  [CRASH_INST_NAME]: {
    id: CRASH_PLAYSAMPLE_ID,
    sequenceStartPosition: 0,                  // 0 means: at segment start (32nd-note units divided by 8 → beats=0)
    sequenceStartPositionOffsetInSeconds: 0.0,
    duration: crashDuration,
    urls: [`/playSample/${CRASH_PLAYSAMPLE_ID}`],
  },
};

const envelope = {
  key: SONG_KEY,
  tempo: TEMPO,
  genre: 'brightPop',
  brainProvenance: {
    generator: 'emit-loop-transition-spike.mjs',
    hash: 'lts-spike-v1',
    params: { spike: 'loop+transition+fills' },
  },
  structure: [
    { segment: 'verse1',  bars: Array.from({ length: VERSE_BARS }, () => ({ chords: [SONG_KEY, SONG_KEY, SONG_KEY, SONG_KEY] })) },
    { segment: 'chorus1', bars: Array.from({ length: CHORUS_BARS }, () => ({ chords: [SONG_KEY, SONG_KEY, SONG_KEY, SONG_KEY] })) },
  ],
  arrangement: {
    verse1: {
      instruments: { Drums: true, Loop: true, [CRASH_INST_NAME]: false },
      overrides:   drumsOverride('verse1'),
      fills:       VERSE_FILLS,
      mutes:       {},
      signalProcessors: {},
      transitions: {},
    },
    chorus1: {
      instruments: { Drums: true, Loop: false, [CRASH_INST_NAME]: true },
      overrides:   drumsOverride('chorus1'),
      fills:       {},
      mutes:       {},
      signalProcessors: {},
      transitions: chorusTransitions,
    },
  },
  // Drums::processSegment calls getInstrumentPattern (via Drums.h:115); without
  // a patterns[] stub it returns early and our override is never applied. (See
  // 54m §"Known engine quirks #3".) Loop and TransitionSample use different
  // processSegment signatures that don't need this.
  patterns: [
    { id: 1, lengthInBars: VERSE_BARS, pattern: [
      // Drums fallback pattern (replaced by override) — engine just needs the lookup to succeed.
      {
        instrumentId: 100, // matches base-drums-inst.json id
        instrumentName: 'Drums',
        instrumentType: 'drums',
        instrumentType1: 'drums',
        patternType: 'drums',
        bars: [{ notes: {} }],
        pattern: { bassDrum1: '00000000000000000000000000000000' },
      },
    ] },
  ],
};

writeFileSync(resolve(OUT, 'song.json'), JSON.stringify(envelope, null, 2));

// ---- 4. inst-1.json: Drums kit (the standard Phase 2 fixture) -----------
const baseDrumsInstPath = resolve(__dirname, '../../../packages/engine-adapter/fixtures/base-drums-inst.json');
const drumsInst = JSON.parse(readFileSync(baseDrumsInstPath, 'utf-8'));
writeFileSync(resolve(OUT, 'inst-1.json'), JSON.stringify(drumsInst, null, 2));

// ---- 5. inst-2.json: Loop instrument ------------------------------------
const loopInst = {
  id: LOOP_PLAYSAMPLE_ID,   // engine uses this as both inst id AND playsample id
  name: 'Loop',
  shortName: 'loop',
  type: 'percussionLoops',
  lowLevelType: loopEntry.lowLevel,
  isSample: true,
  isVst: false,
  details: {
    bpm: TEMPO,                // Loop ctor: std::stoi on details.bpm — must equal SONG tempo for 1:1 playback
    duration: loopDuration,
  },
};
writeFileSync(resolve(OUT, 'inst-2.json'), JSON.stringify(loopInst, null, 2));

// ---- 6. inst-3.json: TransitionSample (cymbalsCrashHit) ----------------
const crashInst = {
  id: CRASH_PLAYSAMPLE_ID,
  name: CRASH_INST_NAME,
  shortName: 'crash',
  type: 'transitionSample',
  lowLevelType: 'cymbalsCrashHit',
  isSample: true,
  isVst: false,
  details: {
    bpm: 0,                     // not used — TransitionSample ctor just reads/jasserts
    duration: crashDuration,
    climax: 0,                  // legacy default for cymbalsCrashHit (no pre-attack)
  },
};
writeFileSync(resolve(OUT, 'inst-3.json'), JSON.stringify(crashInst, null, 2));

// ---- 7. asset-manifest.json (traceability) ------------------------------
const manifest = {
  generatedBy: 'emit-loop-transition-spike.mjs',
  spike: 'loop + transitionSample + drums fills (docs/54o)',
  Loop: {
    status: 'resolved',
    entryId: loopEntry.id,
    family: loopEntry.family,
    lowLevel: loopEntry.lowLevel,
    relativePath: loopRel,
    duration: loopDuration,
    bpm: loopEntry.bpm,
    playsampleId: LOOP_PLAYSAMPLE_ID,
  },
  TransitionSample: {
    status: 'resolved',
    entryId: crashEntry.id,
    family: crashEntry.family,
    lowLevel: crashEntry.lowLevel,
    relativePath: crashRel,
    duration: crashDuration,
    playsampleId: CRASH_PLAYSAMPLE_ID,
  },
  fills: {
    block: VERSE_FILLS,
    placement: 'arrangement.verse1.fills.Drums.patterns.patternEndOfSegment',
  },
};
writeFileSync(resolve(OUT, 'asset-manifest.json'), JSON.stringify(manifest, null, 2));

// ---- 8. Stage drum playsamples + loop + crash ---------------------------
const DRUM_ROLE_TO_FIXTURE = {
  bassDrum1: 'kick.ogg',  bassDrum2: 'kick.ogg',
  snareDrum1: 'snare.ogg', snareDrum2: 'snare.ogg',
  hiHatClosed1: 'hat.ogg', hiHatClosed2: 'hat.ogg',
  hiHatOpen: 'hat.ogg',    hiHatPedal: 'hat.ogg',
};
let drumStaged = 0;
for (const [role, id] of Object.entries(drumsInst.ids ?? {})) {
  const src = resolve(SAMPLES, DRUM_ROLE_TO_FIXTURE[role] ?? 'tone.ogg');
  if (!existsSync(src)) continue;
  copyFileSync(src, join(TEMP_DIR, `playsample-${id}.ogg`));
  // Stage clap.ogg fallback under any existing 'clap' id too (engine reads clap from drum kit ids).
  drumStaged++;
}
// Make sure 'clap' has a distinct sound — bundled fixture uses snare for it.
// The Drums kit's clap id (from base-drums-inst.json) defaults to whatever
// DRUM_ROLE_TO_FIXTURE maps; 'clap' is not in the map, so 'tone.ogg' falls
// through. That's fine — fill audio just needs to be non-silent.
console.error(`[lts-spike] drums fixtures staged: ${drumStaged}/17`);

// Stage Loop: normalize MP3 → OGG and write as playsample-<id>.ogg.
{
  const norm = prepareNormalizedSource({ sourcePath: loopAbs, cacheDir: CACHE_RES.path });
  console.error(formatNormalizationLog(norm, loopAbs));
  if (norm.kind !== 'copy' && norm.kind !== 'transcoded') {
    throw new Error(`loop normalization failed: ${norm.kind}`);
  }
  copyFileSync(norm.preparedPath, join(TEMP_DIR, `playsample-${LOOP_PLAYSAMPLE_ID}.ogg`));
  console.error(`[lts-spike] loop staged: playsample-${LOOP_PLAYSAMPLE_ID}.ogg (${ffprobeSeconds(join(TEMP_DIR, `playsample-${LOOP_PLAYSAMPLE_ID}.ogg`)).toFixed(3)}s)`);
}

// Stage Crash: same.
{
  const norm = prepareNormalizedSource({ sourcePath: crashAbs, cacheDir: CACHE_RES.path });
  console.error(formatNormalizationLog(norm, crashAbs));
  if (norm.kind !== 'copy' && norm.kind !== 'transcoded') {
    throw new Error(`crash normalization failed: ${norm.kind}`);
  }
  copyFileSync(norm.preparedPath, join(TEMP_DIR, `playsample-${CRASH_PLAYSAMPLE_ID}.ogg`));
  console.error(`[lts-spike] crash staged: playsample-${CRASH_PLAYSAMPLE_ID}.ogg`);
}

console.error(`\n[lts-spike] ready. Next:`);
console.error(`  ./native/build/casperaki_spike_artefacts/Debug/casperaki_spike \\`);
console.error(`    "${OUT}" http://127.0.0.1:8080 "${resolve(OUT, 'out.wav')}"`);
console.error(`  pnpm check:wav out/loop-transition-spike/out.wav`);
console.error(`  node scripts/check-spike-rms.mjs out/loop-transition-spike/out.wav`);
