#!/usr/bin/env node
// docs/54o-a — Loop-only spike (Drums + Loop on one segment).

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadValidatedCatalog } from '@casperaki/arrangement';
import { prepareNormalizedSource, formatNormalizationLog } from './lib/audio-normalize.mjs';
import { resolveAudioCacheRoot, formatCacheRootLog } from './lib/audio-cache-root.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SAMPLES = resolve(ROOT, 'samples');
const TEMP_DIR = join(homedir(), '.config', 'CasperakiSpike', 'Temporary');
const OUT = resolve(ROOT, 'out/loop-only-spike');

const ENV_FILE = resolve(__dirname, '../.env');
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
const SAMPLE_LIBRARY_ROOT = process.env.CASPERAKI_SAMPLE_LIBRARY_ROOT;
const CACHE_RES = resolveAudioCacheRoot({
  envValue: process.env.CASPERAKI_AUDIO_CACHE_ROOT,
  repoLocalFallback: resolve(__dirname, '../.cache/audio-normalized'),
});
console.error(formatCacheRootLog(CACHE_RES));

mkdirSync(OUT, { recursive: true });
mkdirSync(TEMP_DIR, { recursive: true });

const catalog = loadValidatedCatalog();
const LOOP_CATALOG_ID = 'ab4c1b66a7fc418c'; // Shaker Tamb2 100bpm
const loopEntry = catalog.byId.get(LOOP_CATALOG_ID);
const loopAbs = join(SAMPLE_LIBRARY_ROOT, loopEntry.matchedPath);
const ffprobe = (p) => Number.parseFloat(execFileSync('ffprobe', ['-v','error','-show_entries','format=duration','-of','csv=p=0', p]).toString().trim());
const loopDuration = ffprobe(loopAbs);
console.error(`[loop-spike] ${loopEntry.preset} duration=${loopDuration}s`);

// docs/54o variant 4f: 8-bar verse, source = 1-bar loop @ 100bpm.
// Loop.h after the patch computes nLoops = ceil(segSec/sourceSec) ≈ 8
// and calls setLength to extend the clip across the segment.
const TEMPO = 100, SONG_KEY = 'C', VERSE_BARS = 8;
const LOOP_ID = 6000;

const envelope = {
  key: SONG_KEY, tempo: TEMPO, genre: 'brightPop',
  brainProvenance: { generator: 'emit-loop-spike.mjs', hash: 'loop-spike-v1', params: {} },
  structure: [
    { segment: 'verse1', bars: Array.from({length: VERSE_BARS}, () => ({chords:[SONG_KEY,SONG_KEY,SONG_KEY,SONG_KEY]})) }
  ],
  arrangement: {
    verse1: {
      instruments: { Drums: true, Loop: true },
      overrides: { Drums: { type: 'spike', pattern: {
        bassDrum1:   'x000000000000000x000000000000000',
        snareDrum1:  '00000000x000000000000000x0000000',
        hiHatClosed1:'x000x000x000x000x000x000x000x000',
      }}},
      fills: {}, mutes: {}, signalProcessors: {}, transitions: {},
    },
  },
  // The engine's getInstrumentPattern returns this entry to Drums::processSegment.
  // Drums.h:339 calls applyPattern(drumsInstrumentPattern, ...) — so the actual
  // 32nd-note grid MUST live in patterns[0].pattern[<drumsId>].pattern (NOT in
  // arrangement.overrides). The override is consulted only for OverrideType +
  // reset semantics. (Brain-roundtrip emits the grid here too — verified
  // against out/brain-roundtrip/song.json.)
  patterns: [{ id: 1, lengthInBars: VERSE_BARS, pattern: [
    {
      instrumentId: 100, instrumentName: 'Drums', instrumentType: 'drums',
      instrumentType1: 'drums', patternType: 'drums',
      pattern: {
        bassDrum1:   'x0000000 x0000000 00000000 00000000',
        snareDrum1:  '00000000 00000000 x0000000 00000000',
        hiHatClosed1:'x000x000 x000x000 x000x000 x000x000',
      },
    },
  ]}],
};
writeFileSync(resolve(OUT, 'song.json'), JSON.stringify(envelope, null, 2));

// Drums kit (silenced via override having minimal hits is fine; we want them audible to confirm Loop doesn't kill Drums)
const drumsInst = JSON.parse(readFileSync(resolve(__dirname, '../../../packages/engine-adapter/fixtures/base-drums-inst.json'), 'utf-8'));
writeFileSync(resolve(OUT, 'inst-1.json'), JSON.stringify(drumsInst, null, 2));

// Loop inst — engine class Loop.h
const loopInst = {
  id: LOOP_ID, name: 'Loop', shortName: 'loop',
  type: 'percussionLoops', lowLevelType: loopEntry.lowLevel,
  isSample: true, isVst: false,
  details: { bpm: TEMPO, duration: loopDuration },
};
writeFileSync(resolve(OUT, 'inst-2.json'), JSON.stringify(loopInst, null, 2));

// Stage drum playsamples
const FIX = { bassDrum1:'kick.ogg', bassDrum2:'kick.ogg', snareDrum1:'snare.ogg', snareDrum2:'snare.ogg', hiHatClosed1:'hat.ogg', hiHatClosed2:'hat.ogg', hiHatOpen:'hat.ogg', hiHatPedal:'hat.ogg' };
for (const [r,id] of Object.entries(drumsInst.ids ?? {})) {
  const src = resolve(SAMPLES, FIX[r] ?? 'tone.ogg');
  if (existsSync(src)) copyFileSync(src, join(TEMP_DIR, `playsample-${id}.ogg`));
}

// Stage loop
const norm = prepareNormalizedSource({ sourcePath: loopAbs, cacheDir: CACHE_RES.path });
console.error(formatNormalizationLog(norm, loopAbs));
copyFileSync(norm.preparedPath, join(TEMP_DIR, `playsample-${LOOP_ID}.ogg`));

console.error(`\n[loop-spike] ready: ${OUT}`);
