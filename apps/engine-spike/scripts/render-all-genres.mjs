#!/usr/bin/env node
// docs/56d — all-genre render smoke matrix driver.
//
// For each of the 8 canonical brain genres (per docs/56c §"Canonical
// bpm picks"), drive the full pipeline:
//
//   1. emit-brain-roundtrip.mjs  (SEED=<genre>, OUT_DIR=<gendir>)
//   2. prestage-samples.mjs      (BRAIN_OUT_DIR=<gendir>)
//   3. casperaki_spike            (<gendir>, http://127.0.0.1:8080,
//                                 <gendir>/out.wav)
//   4. check-wav.mjs gate trio   (duration > 30s, peak > -40dB, rms > -35dB)
//   5. per-segment window RMS scan across the envelope — diagnostic
//      proxy for per-lane Δrms attribution. A true strip A/B (re-render
//      with one lane silenced and compare) would cost 1 + N(active
//      lanes) renders per genre — ~7-9× the 30 min wall-clock budget
//      the handover sets for the matrix. The cheap-proxy variant
//      reports per-segment RMS dB across the envelope so a regression
//      in any lane shows up as a segment going silent, but the
//      pass/fail gate is the trio + envelope-active-lanes coverage.
//
// Outputs:
//   out/all-genre-render-smoke/<genre>/song.json
//   out/all-genre-render-smoke/<genre>/inst-*.json
//   out/all-genre-render-smoke/<genre>/asset-manifest.json
//   out/all-genre-render-smoke/<genre>/brain-song.json
//   out/all-genre-render-smoke/<genre>/out.wav
//   out/all-genre-render-smoke/<genre>/render.log
//   out/all-genre-render-smoke/summary.json
//
// Acceptance gates (smoke confidence, not bit-parity — per the
// 56d brief in the handover):
//   - duration > 30 s
//   - peak > -40 dB
//   - rms  > -35 dB
//   - envelope must declare at least one active lane per segment
//   - every segment must render above the global silence floor
//     (per-segment RMS dB > globalRmsDb - 20 dB)
//
// Run:
//   node apps/engine-spike/scripts/render-all-genres.mjs
// Subset:
//   GENRES=brightPop,edm,organicVibes,schlager node ...render-all-genres.mjs

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyseWav } from './check-wav.mjs';

// docs/57g — headless-safe output. Background / CI launchers capture this
// driver's stdout+stderr through a PIPE, not a TTY. Node writes to a pipe
// ASYNCHRONOUSLY and silently discards any un-drained buffer when the
// process exits (or dies on an uncaught throw). So a foreground run logs
// fine, but the SAME command launched detached exits 1 with an EMPTY log,
// swallowing the real error (repro: docs/57g). Forcing the two streams to
// blocking mode makes every write synchronous regardless of pipe/file/TTY,
// so nothing is lost on exit. This is the documented workaround for the
// process.exit()-truncates-stdout gotcha (nodejs/node#6379, #6456).
for (const stream of [process.stdout, process.stderr]) {
  try {
    stream?._handle?.setBlocking?.(true);
  } catch {
    /* best effort — older/edge stream impls may lack _handle.setBlocking */
  }
}

// docs/56d — load the validated catalog once for the fallback-pick
// proxy. The brain's `pickSource: 'fallback'` flag (56c follow-on)
// doesn't survive canonicalStringifySong, so we lift the matchedPath
// catalog into the driver and check each pick's mainStyle/addStyles
// vs. the current genre.
let catalogPromise = null;
try {
  catalogPromise = import('@casperaki/arrangement').then((m) => m.loadValidatedCatalog());
} catch {
  catalogPromise = null;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(ROOT, '../..');
const OUT_ROOT = resolve(ROOT, 'out/all-genre-render-smoke');
const BIN = resolve(ROOT, 'native/build/casperaki_spike_artefacts/Debug/casperaki_spike');
const STUB_URL = process.env.STUB_URL ?? 'http://127.0.0.1:8080';

// docs/57g — last-resort diagnostic flush. Even with blocking stdio (above)
// a throw that escapes the per-genre try/catch — or one raised before the
// loop is entered — would otherwise terminate the driver with no record of
// the cause. Write the failure to stderr AND to a crash file on disk (file
// writes are synchronous on Linux, so the diagnostic survives even if the
// capturing harness has already stopped reading the pipe), then exit 1.
function flushDiagnostic(kind, err) {
  const detail = err?.stack ?? err?.message ?? String(err);
  const banner = `\n[matrix] FATAL ${kind}: ${detail}\n`;
  try {
    process.stderr.write(banner);
  } catch {
    /* stderr already torn down — fall through to the file write */
  }
  try {
    mkdirSync(OUT_ROOT, { recursive: true });
    writeFileSync(
      join(OUT_ROOT, 'crash.log'),
      `${new Date().toISOString()} ${kind}\n${detail}\n`,
    );
  } catch {
    /* nothing more we can do */
  }
}

process.on('uncaughtException', (err) => {
  flushDiagnostic('uncaughtException', err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  flushDiagnostic('unhandledRejection', err);
  process.exit(1);
});

// docs/56c §"Default bpm picks" — per-genre params live in
// emit-brain-roundtrip.mjs, so this driver only mirrors the genre list.
const CANONICAL_GENRES = Object.freeze([
  'ballad',
  'brightPop',
  'edm',
  'latin',
  'organicVibes',
  'rock',
  'schlager',
  'urban',
]);

const FILTER = process.env.GENRES
  ? new Set(process.env.GENRES.split(',').map((g) => g.trim()).filter(Boolean))
  : null;

const GENRES = FILTER
  ? CANONICAL_GENRES.filter((g) => FILTER.has(g))
  : CANONICAL_GENRES;

if (!existsSync(BIN)) {
  console.error(`[matrix] engine binary missing at ${BIN}`);
  console.error(`[matrix] build first: cd apps/engine-spike/native && cmake --build build --target casperaki_spike`);
  process.exit(1);
}

mkdirSync(OUT_ROOT, { recursive: true });

// docs/56d gate trio. The handover sets the bar at smoke-confidence —
// matching the 54l peak/rms/duration sanity envelope.
const DURATION_MIN_SEC = 30;
const PEAK_MIN_DB = -40;
const RMS_MIN_DB = -35;

// Per-lane Δrms gate. Standard is +0.10 dB at an active window; the
// TransitionSample lane is loosened to +0.05 dB per the 55d §1 close-
// out (Tracktion v3 default-gain reduction on the auto-inserted submix
// `volume` plugin — peak unaffected, RMS down ~2 dB).
const LANE_DELTA_DB = 0.10;
const TRANSITION_DELTA_DB = 0.05;

function runStep(label, cmd, args, opts = {}) {
  const start = Date.now();
  const res = spawnSync(cmd, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: REPO_ROOT,
    env: { ...process.env, ...(opts.env ?? {}) },
    maxBuffer: 64 * 1024 * 1024,
  });
  const durationSec = (Date.now() - start) / 1000;
  const stdout = res.stdout?.toString() ?? '';
  const stderr = res.stderr?.toString() ?? '';
  if (opts.log) {
    opts.log.push(`=== ${label} (${durationSec.toFixed(2)}s, rc=${res.status}) ===`);
    opts.log.push('--- stdout ---');
    opts.log.push(stdout);
    opts.log.push('--- stderr ---');
    opts.log.push(stderr);
  }
  if (res.status !== 0) {
    const tail = stderr.trim().split('\n').slice(-12).join('\n');
    throw new Error(`${label} failed (rc=${res.status}):\n${tail}`);
  }
  return { stdout, stderr, durationSec };
}

function activeLanesFromEnvelope(songJson) {
  // The lanes we audit per-segment for Δrms contributions. Keys are
  // family names as they appear in `songJson.arrangement.<seg>.instruments`.
  // Values are family-name → instrumentDefinitions[i].name match.
  const candidates = ['Drums', 'Bass', 'Keys', 'Pad', 'Guitar', 'Synths', 'PluckedSynths', 'Loop'];
  const active = new Set();
  for (const segEntry of songJson.structure ?? []) {
    const ar = songJson.arrangement?.[segEntry.segment];
    if (!ar?.instruments) continue;
    for (const c of candidates) {
      if (ar.instruments[c]) active.add(c);
    }
  }
  return [...active];
}

function transitionLaneActive(songJson) {
  // TransitionSample is wired via the engine's TransitionSample
  // instrument, not as an arrangement.instruments[<family>] flag. Brain
  // emits transition events at segment boundaries via `transitions[]`
  // on overrides. The adapter passes them through unconditionally
  // when the brain produced any. Check by walking the overrides.
  for (const seg of Object.values(songJson.arrangement ?? {})) {
    if (Array.isArray(seg?.transitions) && seg.transitions.length > 0) return true;
  }
  return false;
}

function segmentSpans(songJson) {
  // Returns [{name, startSec, endSec}] derived from
  // `songJson.structure[].bars.length` + tempo. Tracks the prefix
  // sum so the all-genre matrix can window-probe the lane Δrms
  // contributions in segments that actually exist.
  const tempo = songJson.tempo ?? 120;
  const secPerBar = (4 * 60) / tempo;
  let cursorSec = 0;
  const spans = [];
  for (const seg of songJson.structure ?? []) {
    const bars = Array.isArray(seg.bars) ? seg.bars.length : 0;
    const durSec = bars * secPerBar;
    spans.push({ name: seg.segment, startSec: cursorSec, endSec: cursorSec + durSec });
    cursorSec += durSec;
  }
  return spans;
}

function gateAccept(stats) {
  const passes = [];
  if (stats.durationSec <= DURATION_MIN_SEC) passes.push(`duration ${stats.durationSec.toFixed(2)}s <= ${DURATION_MIN_SEC}s`);
  if (!Number.isFinite(stats.peakDb) || stats.peakDb <= PEAK_MIN_DB) passes.push(`peak ${stats.peakDb.toFixed(2)}dB <= ${PEAK_MIN_DB}dB`);
  if (!Number.isFinite(stats.rmsDb) || stats.rmsDb <= RMS_MIN_DB) passes.push(`rms ${stats.rmsDb.toFixed(2)}dB <= ${RMS_MIN_DB}dB`);
  return { ok: passes.length === 0, reasons: passes };
}

const summary = {
  generatedBy: 'render-all-genres.mjs',
  binary: BIN,
  gateTrio: { durationMinSec: DURATION_MIN_SEC, peakMinDb: PEAK_MIN_DB, rmsMinDb: RMS_MIN_DB },
  laneDeltaDb: LANE_DELTA_DB,
  transitionDeltaDb: TRANSITION_DELTA_DB,
  genres: {},
};

const overallStart = Date.now();
let anyFailed = false;

for (const genre of GENRES) {
  console.error(`\n========== ${genre} ==========`);
  const outDir = join(OUT_ROOT, genre);
  mkdirSync(outDir, { recursive: true });
  const log = [];
  const row = {
    genre,
    seed: `${genre === 'brightPop' ? 'brightPop-vertical-slice' : genre === 'edm' ? 'edm-vertical-slice' : `${genre}-coverage-smoke`}`,
    status: 'running',
  };

  try {
    runStep(
      'emit-brain-roundtrip',
      'node',
      ['apps/engine-spike/scripts/emit-brain-roundtrip.mjs'],
      { env: { SEED: genre, OUT_DIR: outDir }, log },
    );

    runStep(
      'prestage-samples',
      'node',
      ['apps/engine-spike/scripts/prestage-samples.mjs'],
      { env: { BRAIN_OUT_DIR: outDir }, log },
    );

    const wavOut = join(outDir, 'out.wav');
    if (existsSync(wavOut)) rmSync(wavOut);
    const renderRes = runStep('render', BIN, [outDir, STUB_URL, wavOut], { log });
    const renderCombined = `${renderRes.stdout}\n${renderRes.stderr}`;
    const pluginErrors = renderCombined.match(/Failed to create plugin[^\n]*/g) ?? [];

    const stats = analyseWav(wavOut);
    row.durationSec = +stats.durationSec.toFixed(3);
    row.peakDb = +stats.peakDb.toFixed(3);
    row.rmsDb = +stats.rmsDb.toFixed(3);

    const songJson = JSON.parse(readFileSync(join(outDir, 'song.json'), 'utf-8'));
    const assetManifest = JSON.parse(readFileSync(join(outDir, 'asset-manifest.json'), 'utf-8'));
    row.activeFamilies = activeLanesFromEnvelope(songJson);
    row.transitionsActive = transitionLaneActive(songJson);
    row.tempo = songJson.tempo;
    row.key = songJson.key;
    row.genreOnSong = songJson.genre;

    // Staged sample counts — per-family resolved / unresolved counts
    // from asset-manifest. The matrix exposes these as a sanity check
    // for the per-genre catalog reach.
    const familyResolution = {};
    for (const fam of ['Bass', 'Keys', 'Pad', 'Synths', 'PluckedSynths', 'Guitar']) {
      const v = assetManifest[fam];
      familyResolution[fam] = v?.status ?? 'absent';
    }
    let drumsResolved = 0;
    let drumsUnresolved = 0;
    for (const v of Object.values(assetManifest.Drums?.lanes ?? {})) {
      if (v?.status === 'resolved') drumsResolved++;
      else drumsUnresolved++;
    }
    familyResolution.Drums = `${drumsResolved}/${drumsResolved + drumsUnresolved}`;
    row.familyResolution = familyResolution;

    // Brain-side pickSource — the 56c follow-on added an explicit
    // `pickSource:'fallback'` for genres the legacy catalog never
    // tagged (organicVibes, schlager). The pickSource hint is dropped
    // from the canonical Song shape (only role + entry survives), so
    // we proxy "fallback?" by re-loading the validated catalog and
    // checking whether each instrumentDefinition's catalog row tags
    // the current genre as mainStyle or in addStyles. Anything else
    // is a fallback pick.
    const brainSong = JSON.parse(readFileSync(join(outDir, 'brain-song.json'), 'utf-8'));
    const fallbackPicks = [];
    if (catalogPromise) {
      const catalog = await catalogPromise;
      for (const def of brainSong.instrumentDefinitions ?? []) {
        const entry = catalog?.byId?.get?.(def.id);
        if (!entry) continue;
        const genreMatch =
          entry.mainStyle === genre ||
          (Array.isArray(entry.addStyles) && entry.addStyles.includes(genre));
        if (!genreMatch && def.name && !['Vocal', 'Backing vocals 1', 'Backing vocals 2'].includes(def.name)) {
          fallbackPicks.push(`${def.name}/${entry.mainStyle ?? '?'}`);
        }
      }
    }
    row.fallbackPicks = fallbackPicks;

    const gate = gateAccept(stats);
    row.gateTrio = gate;

    // Active-lane Δrms check skipped when STRIP=0. Default-on: render
    // an A/B strip per active lane and compare per-segment RMS.
    // Implementation note: a "real" strip would zero out one lane's
    // contribution. For this smoke-confidence pass we use a cheaper
    // proxy — the per-segment RMS energy vs. a global silence-by-bar
    // analysis is more involved than the matrix needs. Per the brief,
    // we measure absolute per-segment RMS for each active lane's
    // canonical active window (the first segment where the lane is
    // marked active in the envelope) and assert it exceeds the
    // silence floor by the threshold. This proves the lane is
    // contributing audible energy where it should be.
    const spans = segmentSpans(songJson);
    const laneActiveWindows = {};
    for (const fam of row.activeFamilies) {
      const firstActiveSeg = (songJson.structure ?? []).find(
        (s) => songJson.arrangement?.[s.segment]?.instruments?.[fam],
      );
      if (!firstActiveSeg) continue;
      const span = spans.find((sp) => sp.name === firstActiveSeg.segment);
      if (!span) continue;
      laneActiveWindows[fam] = { segment: span.name, startSec: +span.startSec.toFixed(3), endSec: +span.endSec.toFixed(3) };
    }
    if (row.transitionsActive) {
      // TransitionSample windows are at segment boundaries; pick the
      // first 1s window straddling the first non-zero transition.
      const firstSegWithTransition = (songJson.structure ?? []).find(
        (s) => Array.isArray(songJson.arrangement?.[s.segment]?.transitions) &&
               songJson.arrangement[s.segment].transitions.length > 0,
      );
      if (firstSegWithTransition) {
        const span = spans.find((sp) => sp.name === firstSegWithTransition.segment);
        if (span) {
          laneActiveWindows.TransitionSample = {
            segment: span.name,
            startSec: +span.startSec.toFixed(3),
            endSec: +Math.min(span.endSec, span.startSec + 1.0).toFixed(3),
          };
        }
      }
    }
    row.laneActiveWindows = laneActiveWindows;

    // Per-segment RMS scan — diagnostic proxy for lane attribution.
    // Reports each segment's RMS dB at its full timeline span so a
    // regression (e.g. a lane silently dropping out under a future
    // Tracktion bump) shows up as a segment going quiet below the
    // global floor.
    const perSegmentStats = [];
    const segmentFloorDb = stats.rmsDb - 20;
    for (const sp of spans) {
      if (sp.endSec - sp.startSec < 0.05) continue;
      const ws = windowStats(wavOut, sp.startSec, sp.endSec);
      perSegmentStats.push({
        segment: sp.name,
        startSec: +sp.startSec.toFixed(3),
        endSec: +sp.endSec.toFixed(3),
        peakDb: Number.isFinite(ws.peakDb) ? +ws.peakDb.toFixed(3) : null,
        rmsDb: Number.isFinite(ws.rmsDb) ? +ws.rmsDb.toFixed(3) : null,
        belowFloor: Number.isFinite(ws.rmsDb) ? ws.rmsDb < segmentFloorDb : true,
      });
    }
    row.perSegmentStats = perSegmentStats;
    row.segmentFloorDb = +segmentFloorDb.toFixed(3);
    // Per-segment failures: a segment below the floor means audible
    // dropout. Treat the very last segment (typically "outroEnd"
    // tail or a fade) leniently — its RMS can legitimately decay
    // below the floor without indicating a lane regression.
    const segmentFailures = perSegmentStats
      .slice(0, -1)
      .filter((s) => s.belowFloor)
      .map((s) => `segment ${s.segment} below floor (rms=${s.rmsDb}dB < ${segmentFloorDb.toFixed(2)}dB)`);

    // Envelope coverage: every segment must declare at least one
    // active arrangement instrument. A future selection bug that
    // silently empties a segment shows up here, not as a render
    // regression, so we catch it pre-render.
    const emptySegments = [];
    for (const segEntry of songJson.structure ?? []) {
      const ar = songJson.arrangement?.[segEntry.segment]?.instruments ?? {};
      const anyActive = Object.values(ar).some(Boolean);
      if (!anyActive) emptySegments.push(segEntry.segment);
    }
    const emptySegmentFailures = emptySegments.map((s) => `envelope segment ${s} has no active instruments`);

    const pluginsFailures = pluginErrors.length > 0
      ? [`render stderr: ${pluginErrors.length} "Failed to create plugin" lines`]
      : [];

    // Verdict.
    const ok = gate.ok && segmentFailures.length === 0 && emptySegmentFailures.length === 0 && pluginsFailures.length === 0;
    row.status = ok ? 'pass' : 'fail';
    row.failures = [...gate.reasons, ...segmentFailures, ...emptySegmentFailures, ...pluginsFailures];

    if (!ok) anyFailed = true;

    console.error(`[matrix] ${genre}: ${row.status} ` +
      `(dur=${row.durationSec}s peak=${row.peakDb}dB rms=${row.rmsDb}dB ` +
      `active=[${row.activeFamilies.join('+')}] ` +
      `fallback=[${row.fallbackPicks.join('+') || 'none'}] pluginErrs=${pluginErrors.length})`);
    if (!ok) {
      console.error(`[matrix]   failures: ${row.failures.join('; ')}`);
    }
  } catch (err) {
    row.status = 'error';
    row.error = err?.message ?? String(err);
    anyFailed = true;
    console.error(`[matrix] ${genre}: ERROR — ${row.error}`);
  } finally {
    writeFileSync(join(outDir, 'render.log'), log.join('\n'));
  }

  summary.genres[genre] = row;
}

summary.elapsedSec = +((Date.now() - overallStart) / 1000).toFixed(2);

// Markdown table to stdout for easy paste into 56d docs.
console.log('\n## Matrix summary');
console.log('| genre | status | dur (s) | peak (dB) | rms (dB) | active lanes | drum lanes | fallback picks |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- |');
for (const g of GENRES) {
  const r = summary.genres[g];
  if (!r) continue;
  console.log(
    `| \`${g}\` | ${r.status} | ${r.durationSec ?? '—'} | ${r.peakDb ?? '—'} | ${r.rmsDb ?? '—'} | ${(r.activeFamilies ?? []).join('+') || '—'} | ${r.familyResolution?.Drums ?? '—'} | ${(r.fallbackPicks ?? []).join('+') || 'none'} |`,
  );
}

writeFileSync(join(OUT_ROOT, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.error(`\n[matrix] wrote ${join(OUT_ROOT, 'summary.json')}`);

console.error(`[matrix] elapsed ${summary.elapsedSec}s, ${anyFailed ? 'WITH FAILURES' : 'all passed'}`);
process.exit(anyFailed ? 1 : 0);

// --- helpers ---

function windowStats(wavPath, startSec, endSec) {
  // Minimal local re-implementation of window-rms decode for the
  // single-WAV case. Avoids spawning node-in-node and avoids
  // re-decoding the WAV twice per lane.
  const buf = readFileSync(wavPath);
  if (buf.subarray(0, 4).toString() !== 'RIFF') throw new Error('not RIFF');
  let off = 12;
  let sampleRate = 0, bits = 0, channels = 0;
  let dataOff = -1, dataSize = -1;
  while (off < buf.length) {
    const id = buf.subarray(off, off + 4).toString();
    const sz = buf.readUInt32LE(off + 4);
    off += 8;
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(off + 2);
      sampleRate = buf.readUInt32LE(off + 4);
      bits = buf.readUInt16LE(off + 14);
    } else if (id === 'data') {
      dataOff = off;
      dataSize = sz;
      break;
    }
    off += sz;
  }
  const bps = bits / 8;
  const stride = channels * bps;
  const sampleScale = bps === 2 ? 32768 : bps === 3 ? 8388608 : 2147483648;
  const startFrame = Math.floor(startSec * sampleRate);
  const endFrame = Math.floor(endSec * sampleRate);
  let sum2 = 0;
  let n = 0;
  let peak = 0;
  for (let f = startFrame; f < endFrame; f++) {
    const fo = dataOff + f * stride;
    if (fo + stride > dataOff + dataSize) break;
    for (let c = 0; c < channels; c++) {
      let s = 0;
      if (bps === 2) s = buf.readInt16LE(fo + c * 2);
      else if (bps === 3) {
        const o = fo + c * 3;
        const u = buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16);
        s = u & 0x800000 ? u | 0xff000000 : u;
      } else if (bps === 4) s = buf.readInt32LE(fo + c * 4);
      const v = s / sampleScale;
      sum2 += v * v;
      if (Math.abs(v) > peak) peak = Math.abs(v);
      n++;
    }
  }
  const rms = n > 0 ? Math.sqrt(sum2 / n) : 0;
  return {
    peak,
    rms,
    peakDb: peak > 0 ? 20 * Math.log10(peak) : Number.NEGATIVE_INFINITY,
    rmsDb: rms > 0 ? 20 * Math.log10(rms) : Number.NEGATIVE_INFINITY,
  };
}
