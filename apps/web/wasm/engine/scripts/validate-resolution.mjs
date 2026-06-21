#!/usr/bin/env node
// Resolution oracle diff (docs/60 Phase 1 — "validate against the resolution
// oracle"). Compares the WASM engine's resolved-events/v1 output against the
// native harness golden dump for one or all genres.
//
//   node scripts/validate-resolution.mjs [genre]
//
// The native goldens live (gitignored) at
//   apps/engine-spike/out/all-genre-render-smoke/<genre>/resolved-events.json
// produced by apps/engine-spike/scripts/dump-resolved-events.sh.
//
// Comparison policy (docs/61 §2): pitch/timing/structure are exact run-to-run.
// As lanes land this tightens from envelope-level toward per-note diffs. The
// tonal lanes (Synths-class + Bass) are fully ported, so for every track the
// WASM engine emits we hard-assert, per clip:
//   - clip name + start/end seconds
//   - every note's pitch (n + name), start beat, length beats AND velocity
//     (velocity is VelocityMode::beat for these lanes — a pure function of the
//      beat position, no RNG — so it asserts exact, not statistically).
// Notes are canonicalised within each start beat before diffing: the native
// harness serialises ties via std::sort (tracktion_MidiList.h:175), whose order
// at equal start beats is libstdc++-introsort-defined and not musically
// meaningful, so we compare the note multiset per start beat instead of the raw
// serialisation order.
//
// Wave lanes (Loop / Sample Transitions FX) are multiset-compared per track on
// (name, source) with start/end within EPS — te's getClips() order is a
// serialisation artifact (cf. the std::sort note ties / unordered_map channels).
// Lanes not yet ported (Guitar) appear only in the oracle; they are reported as
// PENDING coverage, not failures — but a ported track that goes missing or grows
// extra clips IS a failure.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as presolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const engineDir = presolve(here, '..');
const RESOLVE_BIN = presolve(engineDir, 'build/casperaki_resolve');
const GENRE_ROOT = presolve(
  engineDir, '../../../engine-spike/out/all-genre-render-smoke');

const ALL = ['ballad', 'brightPop', 'edm', 'latin',
             'organicVibes', 'rock', 'schlager', 'urban'];

const only = process.argv[2];
const genres = only ? [only] : ALL;

if (!existsSync(RESOLVE_BIN)) {
  console.error(`missing ${RESOLVE_BIN}\n  build it: cmake -S "${engineDir}" -B "${engineDir}/build" && cmake --build "${engineDir}/build"`);
  process.exit(2);
}

const EPS = 1e-6;
const near = (a, b) => Math.abs(a - b) < EPS;

// Canonical order within a clip: by start beat, then a stable musical key so
// equal-start ties compare as a multiset regardless of serialisation order.
// `velStatistical` (the Guitar short/long tonal tracks) drops velocity from the
// ordering key — those notes draw VelocityMode::randomised from a clock-seeded
// global RNG in the native golden, so velocity is not reproducible against it
// (docs/61 §2): pitch/timing/length still assert exact, velocity is range-only.
function canonNotes(notes, velStatistical = false) {
  return [...(notes || [])].sort((a, b) =>
    a.startBeat - b.startBeat || a.n - b.n || a.lenBeats - b.lenBeats ||
    (velStatistical ? 0 : a.vel - b.vel));
}

// Width of the VelocityMode::randomised perturbation (SequencerUtils.h:653,
// (rng.nextInt(127)-65)/5 ∈ [-13,+12]); two independent draws around the same
// base velocity differ by at most 25. Exceeding it means the BASE velocity is
// wrong, which IS a failure — equality is not required, the band is.
const VEL_RANDOM_BAND = 25;

// Step-clip hits resolve their channel index to (note, name) so the comparison
// is independent of channel ORDER — the native sampler's channel order is
// std::unordered_map hash order (non-musical, non-portable), the step-lane
// analogue of the std::sort note ties. Sorted -> compared as a multiset.
function canonHits(clip) {
  const ch = clip.channels || [];
  const hits = [];
  for (const p of clip.patterns || [])
    for (const h of p.hits)
      hits.push({ note: ch[h.ch]?.n, name: ch[h.ch]?.name, step: h.step, vel: h.vel });
  return hits.sort((a, b) =>
    a.note - b.note || a.step - b.step || a.vel - b.vel ||
    String(a.name).localeCompare(String(b.name)));
}
function canonChannels(clip) {
  return [...(clip.channels || [])]
    .map(c => ({ n: c.n, name: c.name }))
    .sort((a, b) => a.n - b.n || String(a.name).localeCompare(String(b.name)));
}

function diffStepClip(wc, gc, label, msgs) {
  const wch = canonChannels(wc), gch = canonChannels(gc);
  if (JSON.stringify(wch) !== JSON.stringify(gch))
    msgs.push(`${label}: channels WASM ${JSON.stringify(wch)} ORACLE ${JSON.stringify(gch)}`);
  const wSteps = (wc.patterns || []).map(p => p.numSteps).join(',');
  const gSteps = (gc.patterns || []).map(p => p.numSteps).join(',');
  if (wSteps !== gSteps)
    msgs.push(`${label}: numSteps ${wSteps}/${gSteps}`);
  const wh = canonHits(wc), gh = canonHits(gc);
  if (wh.length !== gh.length) {
    msgs.push(`${label}: hit count ${wh.length}/${gh.length}`);
    return 0;
  }
  for (let j = 0; j < wh.length; j++) {
    if (JSON.stringify(wh[j]) !== JSON.stringify(gh[j]))
      msgs.push(`${label} hit: WASM ${JSON.stringify(wh[j])} ORACLE ${JSON.stringify(gh[j])}`);
  }
  return wh.length;
}

// Wave clips (Loop / Sample Transitions FX) are compared as a multiset keyed on
// (name, source) with start/end matched within EPS. The native dump order is
// te's getClips() order — a serialisation artifact, like the std::sort note ties
// and the unordered_map step-channel order — so we sort both sides by a stable
// musical key before the pairwise diff rather than trusting raw clip index.
function canonWaves(clips) {
  return [...(clips || [])].sort((a, b) =>
    a.startSec - b.startSec || a.endSec - b.endSec ||
    String(a.name).localeCompare(String(b.name)) ||
    String(a.source).localeCompare(String(b.source)));
}
function diffWaveTrack(wt, gt, genre) {
  const msgs = [];
  const w = canonWaves(wt.clips), g = canonWaves(gt.clips);
  if (w.length !== g.length) {
    msgs.push(`${genre}/${wt.name}: wave clip count ${w.length}/${g.length}`);
    return { msgs, waveCount: 0 };
  }
  for (let i = 0; i < w.length; i++) {
    const a = w[i], b = g[i];
    if (a.name !== b.name || a.source !== b.source ||
        !near(a.startSec, b.startSec) || !near(a.endSec, b.endSec))
      msgs.push(`${genre}/${wt.name} wave: WASM ${JSON.stringify(a)} ORACLE ${JSON.stringify(b)}`);
  }
  return { msgs, waveCount: w.length };
}

function diffTrack(wt, gt, genre, velStatistical = false) {
  // Loop / Sample Transitions FX are pure wave tracks — multiset-compare them.
  if ((gt.clips || []).length && gt.clips.every(c => c.type === 'wave')) {
    const { msgs, waveCount } = diffWaveTrack(wt, gt, genre);
    return { msgs, noteCount: 0, hitCount: 0, waveCount };
  }
  const msgs = [];
  if (wt.clips.length !== gt.clips.length)
    msgs.push(`${genre}/${wt.name}: clip count ${wt.clips.length}/${gt.clips.length}`);
  const n = Math.min(wt.clips.length, gt.clips.length);
  let noteCount = 0, hitCount = 0;
  for (let i = 0; i < n; i++) {
    const wc = wt.clips[i], gc = gt.clips[i];
    if (wc.name !== gc.name || !near(wc.startSec, gc.startSec) || !near(wc.endSec, gc.endSec))
      msgs.push(`${genre}/${wt.name}[${i}] clip meta: name ${wc.name}/${gc.name} ` +
                `start ${wc.startSec}/${gc.startSec} end ${wc.endSec}/${gc.endSec}`);
    if (wc.type !== gc.type) {
      msgs.push(`${genre}/${wt.name}[${i}] ${wc.name}: type ${wc.type}/${gc.type}`);
      continue;
    }
    if (wc.type === 'step') {
      hitCount += diffStepClip(wc, gc, `${genre}/${wt.name}[${i}] ${wc.name}`, msgs);
      continue;
    }
    const wn = canonNotes(wc.notes, velStatistical), gn = canonNotes(gc.notes, velStatistical);
    if (wn.length !== gn.length) {
      msgs.push(`${genre}/${wt.name}[${i}] ${wc.name}: note count ${wn.length}/${gn.length}`);
      continue;
    }
    for (let j = 0; j < wn.length; j++) {
      const a = wn[j], b = gn[j];
      noteCount++;
      const velBad = velStatistical
        ? Math.abs(a.vel - b.vel) > VEL_RANDOM_BAND
        : a.vel !== b.vel;
      if (a.n !== b.n || a.name !== b.name || !near(a.startBeat, b.startBeat) ||
          !near(a.lenBeats, b.lenBeats) || velBad) {
        msgs.push(`${genre}/${wt.name}[${i}] note: WASM ${JSON.stringify(a)} ORACLE ${JSON.stringify(b)}` +
                  (velStatistical ? ` (vel Δ${Math.abs(a.vel - b.vel)} band ${VEL_RANDOM_BAND})` : ''));
      }
    }
  }
  return { msgs, noteCount, hitCount, waveCount: 0 };
}

let hardFailures = 0;
for (const g of genres) {
  const dir = presolve(GENRE_ROOT, g);
  const goldenPath = presolve(dir, 'resolved-events.json');
  if (!existsSync(goldenPath)) {
    console.log(`SKIP ${g}: no oracle dump (run dump-resolved-events.sh ${g})`);
    continue;
  }
  const golden = JSON.parse(readFileSync(goldenPath, 'utf8'));
  const wasm = JSON.parse(execFileSync(RESOLVE_BIN, [dir], { encoding: 'utf8', maxBuffer: 1e9 }));

  let fail = false;
  const detail = [];

  // Hard assert: structure/timeline.
  if (!near(wasm.lengthSec, golden.lengthSec) || wasm.genre !== golden.genre) {
    fail = true;
    detail.push(`${g}: lengthSec ${wasm.lengthSec}/${golden.lengthSec} genre ${wasm.genre}/${golden.genre}`);
  }

  // A Guitar instrument is the only one that emits a "(strums)"/"(fret noises)"
  // track, so its "(short notes)"/"(long notes)" tracks are the randomised-
  // velocity ones (Bass also has long/short tracks, but those are VelocityMode::
  // beat — exact). Collect the guitar base names to flag velocity as statistical.
  const guitarBases = new Set();
  for (const t of golden.tracks) {
    const m = /^(.*)\((?:strums|fret noises)\)$/.exec(t.name);
    if (m) guitarBases.add(m[1]);
  }
  const isRandomisedVelTrack = (name) => {
    const m = /^(.*)\((?:short|long) notes\)$/.exec(name);
    return !!m && guitarBases.has(m[1]);
  };

  // Per-note diff for every track the WASM engine emits (all ported lanes).
  const gByName = new Map(golden.tracks.map(t => [t.name, t]));
  let notesChecked = 0, hitsChecked = 0, wavesChecked = 0;
  for (const wt of wasm.tracks) {
    const gt = gByName.get(wt.name);
    if (!gt) { fail = true; detail.push(`${g}: WASM track ${wt.name} not in oracle`); continue; }
    const { msgs, noteCount, hitCount, waveCount } = diffTrack(wt, gt, g, isRandomisedVelTrack(wt.name));
    notesChecked += noteCount;
    hitsChecked += hitCount;
    wavesChecked += waveCount;
    if (msgs.length) { fail = true; detail.push(...msgs.slice(0, 6)); }
  }

  // Coverage: oracle tracks not yet emitted by the WASM engine.
  const wNames = new Set(wasm.tracks.map(t => t.name));
  const pending = golden.tracks.filter(t => !wNames.has(t.name)).map(t => t.name);

  if (fail) ++hardFailures;
  const status = fail ? 'FAIL' : 'PASS';
  console.log(
    `${status} ${g.padEnd(13)} len ${wasm.lengthSec.toFixed(3)}` +
    `  tracks ${wasm.tracks.length}/${golden.tracks.length}` +
    `  notes✓ ${notesChecked}  stepHits✓ ${hitsChecked}  waveClips✓ ${wavesChecked}` +
    (pending.length ? `  pending: ${pending.join(', ')}` : ''));
  for (const d of detail) console.log('  ' + d);
}

console.log(hardFailures === 0
  ? '\nAll lanes match the oracle: pitch/timing/structure exact per note; velocity\n' +
    'exact except the Guitar short/long tonal tracks (randomised — range-validated).'
  : `\n${hardFailures} genre(s) with hard failures`);
process.exit(hardFailures === 0 ? 0 : 1);
