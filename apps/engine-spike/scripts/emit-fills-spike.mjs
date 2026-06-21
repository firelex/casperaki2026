#!/usr/bin/env node
// docs/54o-c — Fills-only spike. Uses the existing brain-roundtrip output
// as the base envelope, then injects an `arrangement.<seg>.fills.Drums`
// block (the same shape 53aa already emits in brain Song bytes, but the
// engine adapter currently writes empty `fills: {}` instead). Renders
// the same multi-segment chorus1 and looks for a measurable energy bump
// in the bars where the fill should land.
//
// Self-contained: writes to out/fills-only-spike/. Re-uses brain-
// roundtrip artefacts verbatim except for the per-segment fills block.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC_BRAIN = resolve(ROOT, 'out/brain-roundtrip');
const OUT = resolve(ROOT, 'out/fills-only-spike');

if (!existsSync(SRC_BRAIN) || !existsSync(resolve(SRC_BRAIN, 'song.json'))) {
  console.error(`[fills-spike] brain-roundtrip output missing — run \`pnpm emit:brain-roundtrip\` first`);
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

// ---- 1. Copy brain-roundtrip inst-*.json verbatim ------------------------
let copied = 0;
for (const f of readdirSync(SRC_BRAIN)) {
  if (f.startsWith('inst-') && f.endsWith('.json')) {
    copyFileSync(resolve(SRC_BRAIN, f), resolve(OUT, f));
    copied++;
  }
}
console.error(`[fills-spike] copied ${copied} inst-*.json files from brain-roundtrip`);

// ---- 2. Load brain song.json, inject fills on every Drums-active segment -
const song = JSON.parse(readFileSync(resolve(SRC_BRAIN, 'song.json'), 'utf-8'));

// A medium-fill grid (~half-bar of claps + snare hits across the last bar)
// chosen so the fill is AUDIBLY DIFFERENT from the default kick/snare pattern.
// Brain emits a snareDrum1 lane in chorus1 with hits on beats 1+3 (slot 8+24).
// We'll add a small clap fill on the SAME LAST BAR via patternEndOfSegment.
const FILL_BLOCK = {
  Drums: {
    reset: false,
    patterns: {
      // patternEndOfSegment is computed by Drums.h:151-154 as:
      //   startBar = barsCount - patternBarsCount - 1
      // For barsCount=8 and our patternBarsCount=1, startBar = 6 → second-to-last bar.
      patternEndOfSegment: {
        // Pile snareDrum1 hits across the bar so the fill is plainly audible
        // over the kick-on-1+3 baseline.
        snareDrum1: 'x000x000 x000x000 x000x000 x000x000',
        clap:       '00000000 00000000 00000000 x0x0x0x0',
      },
    },
  },
};

let segWithFills = 0;
for (const [segName, seg] of Object.entries(song.arrangement ?? {})) {
  // Only inject on segments that already activate Drums.
  if (seg.instruments?.Drums !== true) continue;
  // Only inject on segments with ≥ 4 bars (patternEndOfSegment requires
  // barsCount - patternBarsCount - 1 ≥ 0).
  const bars = song.structure.find((s) => s.segment === segName)?.bars?.length ?? 0;
  if (bars < 4) continue;
  seg.fills = JSON.parse(JSON.stringify(FILL_BLOCK));
  segWithFills++;
}
console.error(`[fills-spike] injected fills on ${segWithFills} drums-active segments`);

writeFileSync(resolve(OUT, 'song.json'), JSON.stringify(song, null, 2));

// ---- 3. asset-manifest.json (trivial, for traceability) ------------------
writeFileSync(
  resolve(OUT, 'asset-manifest.json'),
  JSON.stringify({
    generatedBy: 'emit-fills-spike.mjs',
    spike: 'drum fills pass-through (docs/54o-c)',
    fills: {
      block: FILL_BLOCK,
      injectedOnSegments: segWithFills,
    },
    note: 'brain-roundtrip inst-*.json + playsamples re-used verbatim — no resampling.',
  }, null, 2),
);

console.error(`\n[fills-spike] ready: ${OUT}`);
console.error(`  re-uses staged drums/bass/keys/pad/guitar playsamples from ~/.config/CasperakiSpike/Temporary/`);
console.error(`  next: ./native/build/casperaki_spike_artefacts/Debug/casperaki_spike "${OUT}" http://127.0.0.1:8080 "${resolve(OUT, 'out.wav')}"`);
