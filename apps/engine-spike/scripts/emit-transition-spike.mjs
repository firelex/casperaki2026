#!/usr/bin/env node
// docs/54o-b — TransitionSample-only spike (Drums + cymbalsCrashHit at chorus1 start).

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
const OUT = resolve(ROOT, 'out/transition-only-spike');

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
// Pick a brightPop cymbalsCrashHit. Sort by id for determinism.
const crashRows = catalog.entries
  .filter((e) => e.family === 'cymbals' && e.lowLevel === 'cymbalsCrashHit' &&
                 (e.mainStyle === 'brightPop' || (e.addStyles || []).includes('brightPop')))
  .sort((a, b) => (a.id < b.id ? -1 : 1));
const crashEntry = crashRows[0];
const crashAbs = join(SAMPLE_LIBRARY_ROOT, crashEntry.matchedPath);
const ffprobe = (p) => Number.parseFloat(execFileSync('ffprobe', ['-v','error','-show_entries','format=duration','-of','csv=p=0', p]).toString().trim());
const crashDuration = ffprobe(crashAbs);
console.error(`[trans-spike] crash: ${crashEntry.preset} duration=${crashDuration}s`);

const TEMPO = 100, SONG_KEY = 'C', VERSE_BARS = 4, CHORUS_BARS = 4;
const CRASH_INST_NAME = 'cymbalsCrashHit';
const CRASH_PLAYSAMPLE_ID = 6001;

const envelope = {
  key: SONG_KEY, tempo: TEMPO, genre: 'brightPop',
  brainProvenance: { generator: 'emit-transition-spike.mjs', hash: 'trans-spike-v1', params: {} },
  structure: [
    { segment: 'verse1',  bars: Array.from({length: VERSE_BARS}, () => ({chords:[SONG_KEY,SONG_KEY,SONG_KEY,SONG_KEY]})) },
    { segment: 'chorus1', bars: Array.from({length: CHORUS_BARS}, () => ({chords:[SONG_KEY,SONG_KEY,SONG_KEY,SONG_KEY]})) },
  ],
  arrangement: {
    verse1: {
      instruments: { Drums: true, [CRASH_INST_NAME]: false },
      overrides: {}, fills: {}, mutes: {}, signalProcessors: {}, transitions: {},
    },
    chorus1: {
      instruments: { Drums: true, [CRASH_INST_NAME]: true },
      overrides: {}, fills: {}, mutes: {}, signalProcessors: {},
      transitions: {
        [CRASH_INST_NAME]: {
          id: CRASH_PLAYSAMPLE_ID,
          sequenceStartPosition: 0,
          sequenceStartPositionOffsetInSeconds: 0.0,
          duration: crashDuration,
          urls: [`/playSample/${CRASH_PLAYSAMPLE_ID}`],
        },
      },
    },
  },
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

const drumsInst = JSON.parse(readFileSync(resolve(__dirname, '../../../packages/engine-adapter/fixtures/base-drums-inst.json'), 'utf-8'));
writeFileSync(resolve(OUT, 'inst-1.json'), JSON.stringify(drumsInst, null, 2));

const crashInst = {
  id: CRASH_PLAYSAMPLE_ID, name: CRASH_INST_NAME, shortName: 'crash',
  type: 'transitionSample', lowLevelType: 'cymbalsCrashHit',
  isSample: true, isVst: false,
  details: { bpm: 0, duration: crashDuration, climax: 0 },
};
writeFileSync(resolve(OUT, 'inst-3.json'), JSON.stringify(crashInst, null, 2));

// Stage drum playsamples
const FIX = { bassDrum1:'kick.ogg', bassDrum2:'kick.ogg', snareDrum1:'snare.ogg', snareDrum2:'snare.ogg', hiHatClosed1:'hat.ogg', hiHatClosed2:'hat.ogg', hiHatOpen:'hat.ogg', hiHatPedal:'hat.ogg' };
for (const [r,id] of Object.entries(drumsInst.ids ?? {})) {
  const src = resolve(SAMPLES, FIX[r] ?? 'tone.ogg');
  if (existsSync(src)) copyFileSync(src, join(TEMP_DIR, `playsample-${id}.ogg`));
}

// Stage crash
const norm = prepareNormalizedSource({ sourcePath: crashAbs, cacheDir: CACHE_RES.path });
console.error(formatNormalizationLog(norm, crashAbs));
copyFileSync(norm.preparedPath, join(TEMP_DIR, `playsample-${CRASH_PLAYSAMPLE_ID}.ogg`));

console.error(`\n[trans-spike] ready: ${OUT}`);
