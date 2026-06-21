#!/usr/bin/env node
// docs/54m — Guitar render spike.
//
// Builds a SELF-CONTAINED engine envelope under `out/guitar-spike/`
// that exercises BOTH halves of the Guitar engine class:
//
//   1. Per-note multisamples (samples[]) — proved by 54l's slicing
//      pipeline. We slice `<preset>/<preset> Default Notes.mp3` via
//      `guitarNotes.json` timings (15 longNote + 1 IGNORE + 15
//      shortNote at e2..a#5) into per-slot vstsample-<id>.ogg.
//   2. Chord strums (virtualGuitaristSamples[]) — proved by mapping
//      `(chord, chordPosition, type)` triples to pre-sliced files in
//      `<preset>/chords/` (1727 files per preset). Each is normalised
//      via ffmpeg + staged as `playsample-<id>.ogg`.
//
// What this spike does NOT prove:
//   - Brain-side guitar pattern generation — selection + the
//     VirtualGuitaristPatternGenerator port. The brightPop-vertical-
//     slice's `BRIGHTPOP_ROLES` does NOT include 'guitar' so the brain
//     emits no guitar events today. This spike injects deterministic
//     guitar overrides directly.
//   - String-by-string strum lowering (`type: 'strum'`) — uses
//     `GuitarChord` positional MIDI per string. Out of scope for this
//     spike; the simpler `type: 'virtualGuitarist'` event covers the
//     chord-strum playback path through a single TimeStrums entry.
//   - Fret-noise events (`type: 'fretNoise'` + Default FX.mp3
//     slicing). We stage ONE dummy fxFretNoise id so the engine's
//     initTracks doesn't null-deref but the pattern emits no
//     fretNoise events.
//
// Pipeline:
//   1. Resolve a `Default Notes` catalog row for an
//      acousticGuitarsSteelStereo brightPop preset.
//   2. Build a minimal engine envelope: 4 bars at 120bpm of C-major,
//      Drums(silenced) + Guitar(active). Bars 0-1 emit noteAbsolute
//      melody (per-note pool); bars 2-3 emit virtualGuitarist
//      chordLongStrumDown / chordShortStrumDown / chordShortStrumUp
//      events (strum pool).
//   3. Include the engine's required `patterns[]` stub (see
//      SequencerUtils.h:75 getInstrumentPattern — without it,
//      TonalInstrument::processSegment returns early and the override
//      is never consumed).
//   4. Stage the per-note multisamples via 54l + the chord-strum
//      files via stage-guitar-strums.mjs.
//
// Run:
//   node scripts/emit-guitar-spike.mjs
//   ./native/build/casperaki_spike_artefacts/Debug/casperaki_spike \
//     "$(pwd)/out/guitar-spike" http://127.0.0.1:8080 \
//     "$(pwd)/out/guitar-spike/out.wav"
//   pnpm check:wav out/guitar-spike/out.wav
//   node scripts/analyse-wav-pitch.mjs out/guitar-spike/out.wav 0.5 1.0  # bar 0 noteAbsolute
//   node scripts/analyse-wav-pitch.mjs out/guitar-spike/out.wav 4.5 1.0  # bar 2 long strum

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadValidatedCatalog,
  resolveAssetPath,
} from '@casperaki/arrangement';

import { resolveMultisampleSlots } from './lib/multisample-resolver.mjs';
import { stageMultisampleFamily } from './lib/stage-multisample.mjs';
import { stageGuitarStrums } from './lib/stage-guitar-strums.mjs';
import { resolveAudioCacheRoot, formatCacheRootLog } from './lib/audio-cache-root.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SAMPLES = resolve(ROOT, 'samples');
const TEMP_DIR = join(homedir(), '.config', 'CasperakiSpike', 'Temporary');
const OUT = resolve(ROOT, 'out/guitar-spike');
const MANIFEST_PATH = resolve(OUT, 'asset-manifest.json');

// Load engine-spike .env (CASPERAKI_SAMPLE_LIBRARY_ROOT /
// CASPERAKI_AUDIO_CACHE_ROOT) the same way prestage-samples.mjs does.
const ENV_FILE = resolve(__dirname, '../.env');
if (existsSync(ENV_FILE)) {
  process.loadEnvFile(ENV_FILE);
  console.error(`[guitar-spike] loaded env file: ${ENV_FILE}`);
}
const SAMPLE_LIBRARY_ROOT = process.env.CASPERAKI_SAMPLE_LIBRARY_ROOT;
const CACHE_RES = resolveAudioCacheRoot({
  envValue: process.env.CASPERAKI_AUDIO_CACHE_ROOT,
  repoLocalFallback: resolve(__dirname, '../.cache/audio-normalized'),
});
console.error(formatCacheRootLog(CACHE_RES));

mkdirSync(OUT, { recursive: true });
mkdirSync(TEMP_DIR, { recursive: true });

// ---- 1. Resolve catalog Default-Notes row ---------------------------------
const GUITAR_CATALOG_ID = 'c100ac718e82f8da'; // acousticGuitarsSteelStereo / Default Notes
const catalog = loadValidatedCatalog();
const guitarEntry = catalog.byId.get(GUITAR_CATALOG_ID);
if (!guitarEntry) {
  console.error(`[guitar-spike] catalog id ${GUITAR_CATALOG_ID} not in validated catalog — aborting`);
  process.exit(2);
}
const guitarVerdict = resolveAssetPath({
  entry: guitarEntry,
  target: { key: 'C', bpm: 120 },
});
console.error(`[guitar-spike] selected catalog row: ${guitarEntry.preset} (${guitarEntry.id})`);
console.error(`[guitar-spike] asset-resolver verdict: ${guitarVerdict.status} ${guitarVerdict.relativePath ?? guitarVerdict.diagnostics?.reason}`);

// Compute the `chords/` directory path: peer-of the preset MP3.
// e.g. `acousticGuitars/acousticGuitarsSteelStereo/<preset>.mp3`
//   → `acousticGuitars/acousticGuitarsSteelStereo/chords/`
const chordsRelDir = guitarVerdict.relativePath
  ? `${dirname(guitarVerdict.relativePath)}/chords`
  : undefined;
const chordsAbsDir = (SAMPLE_LIBRARY_ROOT && chordsRelDir)
  ? join(SAMPLE_LIBRARY_ROOT, chordsRelDir)
  : undefined;
console.error(`[guitar-spike] chords folder: ${chordsAbsDir ?? '<unavailable — SAMPLE_LIBRARY_ROOT unset or verdict unresolved>'}`);

// ---- 2. Build the engine envelope -----------------------------------------
const SEG = 'chorus1';
const BARS = 4;
const TEMPO = 120;
const SONG_KEY = 'C';
const GUITAR_VST_ID = 39111;

// Bars 0-1: noteAbsolute melody hitting guitarNotes.json zone roots
// (E4=64, G4=67, A#4=70, C#5=73) — playbackRatio=1.0 in each slot →
// audible pitch = the slice's natural pitch.
const NOTE_BAR = {
  notes: {
    '0.0': [{ type: 'noteAbsolute', note: 'e4',  duration: 1 }],
    '1.0': [{ type: 'noteAbsolute', note: 'g4',  duration: 1 }],
    '2.0': [{ type: 'noteAbsolute', note: 'a#4', duration: 1 }],
    '3.0': [{ type: 'noteAbsolute', note: 'c#5', duration: 1 }],
  },
};
// Bar 2: one C-major long strum down across the bar.
const LONG_STRUM_BAR = {
  notes: {
    '0.0': [{
      type: 'virtualGuitarist',
      event: 'chordLongStrumDown',
      chord: 'C',
      chordPosition: '1',
      duration: 4,
    }],
  },
};
// Bar 3: alternating short strums down/up on the beats.
const SHORT_STRUM_BAR = {
  notes: {
    '0.0': [{ type: 'virtualGuitarist', event: 'chordShortStrumDown', chord: 'C', chordPosition: '1', duration: 1 }],
    '1.0': [{ type: 'virtualGuitarist', event: 'chordShortStrumUp',   chord: 'C', chordPosition: '1', duration: 1 }],
    '2.0': [{ type: 'virtualGuitarist', event: 'chordShortStrumDown', chord: 'C', chordPosition: '1', duration: 1 }],
    '3.0': [{ type: 'virtualGuitarist', event: 'chordShortStrumUp',   chord: 'C', chordPosition: '1', duration: 1 }],
  },
};
const guitarOverrideBars = [NOTE_BAR, NOTE_BAR, LONG_STRUM_BAR, SHORT_STRUM_BAR];

const envelope = {
  key: SONG_KEY,
  tempo: TEMPO,
  genre: 'brightPop',
  brainProvenance: {
    generator: 'emit-guitar-spike.mjs',
    hash: 'guitar-spike-v1',
    params: { spike: 'guitar', catalog: GUITAR_CATALOG_ID },
  },
  structure: [
    {
      segment: SEG,
      bars: Array.from({ length: BARS }, () => ({ chords: [SONG_KEY, SONG_KEY, SONG_KEY, SONG_KEY] })),
    },
  ],
  arrangement: {
    [SEG]: {
      instruments: { Drums: false, Guitar: true },
      overrides: {
        Guitar: { type: 'guitarSpike', bars: guitarOverrideBars },
      },
      fills: {},
      mutes: {},
      signalProcessors: {},
      transitions: {},
    },
  },
  // Engine's getInstrumentPattern (SequencerUtils.h:75) requires
  // patterns[0].pattern[] entries — without it the lookup throws,
  // returns juce::var::undefined(), and TonalInstrument::processSegment
  // returns EARLY without ever consulting the per-segment override.
  // This stub gives the engine something to find for our Guitar id;
  // the per-segment override above is what actually drives playback.
  patterns: [
    {
      id: 1,
      lengthInBars: BARS,
      pattern: [
        {
          instrumentId: GUITAR_VST_ID,
          instrumentName: 'Guitar',
          instrumentType: 'customInstrument',
          instrumentType1: guitarEntry.lowLevel,
          patternType: 'instrument',
          bars: guitarOverrideBars,
        },
      ],
    },
  ],
};

writeFileSync(resolve(OUT, 'song.json'), JSON.stringify(envelope, null, 2));

// ---- 3. inst-1.json (Drums, silenced) — Phase 2 known-good kit -----------
const baseDrumsInstPath = resolve(__dirname, '../../../packages/engine-adapter/fixtures/base-drums-inst.json');
const drumsInst = JSON.parse(readFileSync(baseDrumsInstPath, 'utf-8'));
writeFileSync(resolve(OUT, 'inst-1.json'), JSON.stringify(drumsInst, null, 2));

// ---- 4. inst-5.json (Guitar) ---------------------------------------------
// Three pools:
//   samples[]                — 30 per-note multisamples (15 long + 15 short)
//   fx.fxFretNoise[]         — required by initTracks; one dummy id staged
//   virtualGuitaristSamples[] — chord-strum entries the override references
const GUITAR_NOTE_GRID = ['e2', 'g2', 'a#2', 'c#3', 'e3', 'g3', 'a#3', 'c#4', 'e4', 'g4', 'a#4', 'c#5', 'e5', 'g5', 'a#5'];
const FRET_NOISE_DUMMY_ID = 5100;
const guitarSamples = [];
let nextId = 5000;
for (const note of GUITAR_NOTE_GRID) guitarSamples.push({ id: nextId++, note, type: 'longNote',  vst: GUITAR_VST_ID });
for (const note of GUITAR_NOTE_GRID) guitarSamples.push({ id: nextId++, note, type: 'shortNote', vst: GUITAR_VST_ID });

// Three chord-strum entries — one per (chord, position, type) the
// override references. The engine's `ensureSampleMidiNote` (Guitar.h:242)
// matches on `(chord, chordPosition, type)` triples.
const STRUM_ENTRIES = [
  { id: 5200, chord: 'C', chordPosition: '1', type: 'chordLongStrumDown',  fx: null, vst: GUITAR_VST_ID, note: null },
  { id: 5201, chord: 'C', chordPosition: '1', type: 'chordShortStrumDown', fx: null, vst: GUITAR_VST_ID, note: null },
  { id: 5202, chord: 'C', chordPosition: '1', type: 'chordShortStrumUp',   fx: null, vst: GUITAR_VST_ID, note: null },
];

const guitarInst = {
  details: { LUFS: null, octaveAdjustment: null },
  id: GUITAR_VST_ID,
  instrumentGroup: 'acousticGuitars',
  isSample: false,
  isStrummer: true,
  isVst: true,
  lowLevelType: guitarEntry.lowLevel,
  name: 'Guitar',
  shortName: 'guitar',
  type: 'acousticGuitars',
  samples: guitarSamples,
  fx: {
    fxFretNoise: [FRET_NOISE_DUMMY_ID],
  },
  virtualGuitaristSamples: STRUM_ENTRIES,
};
writeFileSync(resolve(OUT, 'inst-5.json'), JSON.stringify(guitarInst, null, 2));

// ---- 5. asset-manifest.json ----------------------------------------------
let multisamplePlan;
try {
  multisamplePlan = resolveMultisampleSlots({
    family: guitarEntry.family, // 'acousticGuitars'
    samples: guitarSamples.map((s) => ({ id: s.id, note: s.note, type: s.type })),
  });
} catch (err) {
  multisamplePlan = {
    timingName: null, resolvedCount: 0, unresolvedCount: guitarSamples.length,
    total: guitarSamples.length, reason: `resolver threw: ${err?.message ?? String(err)}`, slots: [],
  };
}
const manifest = {
  generatedBy: 'emit-guitar-spike.mjs',
  spike: 'guitar (docs/54m) — notes + strums',
  Guitar: {
    status: guitarVerdict.status,
    relativePath: guitarVerdict.relativePath,
    matchKind: guitarVerdict.matchKind,
    entryId: guitarEntry.id,
    family: guitarEntry.family,
    lowLevel: guitarEntry.lowLevel,
    multisample: {
      timingName: multisamplePlan.timingName,
      resolvedCount: multisamplePlan.resolvedCount,
      unresolvedCount: multisamplePlan.unresolvedCount,
      total: multisamplePlan.total,
      reason: multisamplePlan.reason,
      slots: multisamplePlan.slots,
    },
    strums: {
      chordsRelDir,
      chordsAbsDir,
      entries: STRUM_ENTRIES,
    },
  },
};
writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));

console.error(`[guitar-spike] envelope written → ${OUT}`);
console.error(`[guitar-spike] inst-5.json: ${guitarSamples.length} per-note slots + ${STRUM_ENTRIES.length} strum entries + 1 dummy fret-noise`);
console.error(`[guitar-spike] multisample plan: ${multisamplePlan.timingName} resolved=${multisamplePlan.resolvedCount}/${multisamplePlan.total}`);

// ---- 6. Stage Drums playsamples (silenced) -------------------------------
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
  drumStaged++;
}
console.error(`[guitar-spike] drums fixtures staged (silenced): ${drumStaged}/17 slots`);

// Dummy fret-noise — engine plugin construction requires the file to
// be loadable; never triggered because our pattern emits no fretNoise
// events.
copyFileSync(resolve(SAMPLES, 'tone.ogg'), join(TEMP_DIR, `playsample-${FRET_NOISE_DUMMY_ID}.ogg`));
console.error(`[guitar-spike] fret-noise dummy staged: playsample-${FRET_NOISE_DUMMY_ID}.ogg`);

// ---- 7. Stage Guitar per-note multisample slices via 54l pipeline --------
const guitarStage = stageMultisampleFamily({
  family: 'Guitar',
  fixtureRel: 'tone.ogg',
  instPath: resolve(OUT, 'inst-5.json'),
  manifestPath: MANIFEST_PATH,
  sampleLibraryRoot: SAMPLE_LIBRARY_ROOT,
  fixtureSamplesDir: SAMPLES,
  tempDir: TEMP_DIR,
  normalizeCacheDir: CACHE_RES.path,
});
console.error(`[guitar-spike] notes staging: ${guitarStage.realSliceCount}/${guitarStage.staged} real slices, ${guitarStage.fixtureFallbackCount} fixture fallbacks, timing=${guitarStage.timingName}`);

// ---- 8. Stage chord-strum samples ----------------------------------------
let strumStage = { staged: 0, realCount: 0, skipped: STRUM_ENTRIES.length, entries: [], logs: [] };
if (chordsAbsDir) {
  strumStage = stageGuitarStrums({
    entries: STRUM_ENTRIES,
    chordsAbsDir,
    tempDir: TEMP_DIR,
    normalizeCacheDir: CACHE_RES.path,
  });
} else {
  console.error(`[guitar-spike] strums staging SKIPPED — chordsAbsDir unavailable`);
}
console.error(`[guitar-spike] strums staging: ${strumStage.realCount}/${STRUM_ENTRIES.length} real, ${strumStage.skipped} skipped`);

// ---- Done. Next step is the native render -------------------------------
console.error(`\n[guitar-spike] ready. Next:`);
console.error(`  ./native/build/casperaki_spike_artefacts/Debug/casperaki_spike \\`);
console.error(`    "${OUT}" http://127.0.0.1:8080 "${resolve(OUT, 'out.wav')}"`);
console.error(`  pnpm check:wav out/guitar-spike/out.wav`);
console.error(`  node scripts/analyse-wav-pitch.mjs out/guitar-spike/out.wav 0.5 1.0  # bar 0 noteAbsolute (E4 region)`);
console.error(`  node scripts/analyse-wav-pitch.mjs out/guitar-spike/out.wav 4.5 1.0  # bar 2 long strum (C major)`);
console.error(`  node scripts/analyse-wav-pitch.mjs out/guitar-spike/out.wav 6.5 0.5  # bar 3 short strum up`);
