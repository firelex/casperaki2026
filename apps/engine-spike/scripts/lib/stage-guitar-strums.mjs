// docs/54m — Guitar chord-strum staging.
//
// The Guitar engine class (Guitar.h) has TWO sample pools:
//   1. per-note multisamples (samples[]) — covered by 54l + the
//      multisample-resolver/stage-multisample pipeline.
//   2. virtualGuitaristSamples[] — chord-strum BLOBs identified by
//      `{chord, chordPosition, type}` triples. Lazy-loaded by the
//      engine's `ensureSampleMidiNote` via `virtualGuitaristSample/
//      load/<id>` → written to `playsample-<id>.ogg`.
//
// Pool (2) is NOT a multisample-of-one-source pipeline. The legacy
// library's `<preset>/chords/` subfolder carries 1727 pre-sliced
// individual MP3s — one per `(chord, chordPosition, type)` combination
// — produced by an offline render of longChords.rpp / shortChords.rpp.
//
// This module:
//   1. Takes a list of `{chord, chordPosition, type, id}` triples.
//   2. For each, looks up the per-chord file under
//      `<libRoot>/<chordsRelDir>/<chord> _ Pos <pos> _ <Long|Short> Strum <Down|Up>.mp3`.
//   3. Normalises the bytes through audio-normalize.mjs (mp3 → ogg
//      transcode with the existing 54i cache).
//   4. Copies the resulting OGG bytes into the JUCE temp dir as
//      `playsample-<id>.ogg` — the same naming convention
//      `SampleDownloader.downloadSamples(..., "playsample", ids)` uses.

import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';

import { prepareNormalizedSource, formatNormalizationLog } from './audio-normalize.mjs';

/**
 * Map a TimeStrums type-string to the chord-file naming convention.
 *   "chordLongStrumDown"  → "Long Strum Down"
 *   "chordShortStrumUp"   → "Short Strum Up"
 *
 * @param {string} type
 * @returns {string | undefined}
 */
export function chordTypeToFileSuffix(type) {
  const m = String(type).match(/^chord(Long|Short)Strum(Up|Down)$/u);
  if (!m) return undefined;
  return `${m[1]} Strum ${m[2]}`;
}

/**
 * Compute the chord-file basename for a `(chord, chordPosition, type)`
 * triple, following the legacy `<preset>/chords/` naming convention:
 *
 *   "C", "1", "chordLongStrumDown"   → "C _ Pos 1 _ Long Strum Down.mp3"
 *   "F#m", "3", "chordShortStrumUp"  → "F#m _ Pos 3 _ Short Strum Up.mp3"
 *
 * @param {{ chord: string; chordPosition: string | number; type: string }} entry
 * @returns {string | undefined}
 */
export function chordFileBasename({ chord, chordPosition, type }) {
  const suffix = chordTypeToFileSuffix(type);
  if (!suffix) return undefined;
  const pos = String(chordPosition);
  return `${chord} _ Pos ${pos} _ ${suffix}.mp3`;
}

/**
 * @typedef {{
 *   id: number;
 *   chord: string;
 *   chordPosition: string;
 *   type: string;
 *   fx?: string | null;
 * }} VirtualGuitaristEntry
 */

/**
 * @typedef {{
 *   entryId: number;
 *   chord: string;
 *   chordPosition: string;
 *   type: string;
 *   kind: 'real-strum' | 'no-source';
 *   sourcePath?: string;
 *   stagedSourcePath?: string;
 *   fallbackReason?: string;
 * }} StrumStageRecord
 */

/**
 * Stage all virtualGuitarist chord-strum + fx samples for one guitar inst.
 *
 * 54v scope: chord-strum entries only (`fx === null`); fall back to
 * `chordsAbsDir + <chord>_Pos_<N>_<Long|Short> Strum <Up|Down>.mp3`.
 * 54y extension: fx entries (`fx === "fx1".."fx7"`); fall back to
 * `fxAbsDir + <fxN>.mp3` (i.e. `<preset>/fx/fx1.mp3`, …, `fx7.mp3`).
 *
 * `fxAbsDir` is optional — when omitted, fx entries are skipped with
 * an explicit error record (no silent fallback).
 *
 * @param {{
 *   entries: VirtualGuitaristEntry[];
 *   chordsAbsDir: string;             // e.g. /mnt/d/.../acousticGuitarsSteelStereo/chords
 *   fxAbsDir?: string;                // e.g. /mnt/d/.../acousticGuitarsSteelStereo/fx
 *   tempDir: string;                  // ~/.config/CasperakiSpike/Temporary
 *   normalizeCacheDir: string;
 *   log?: (m: string) => void;
 *   prepareNormalized?: typeof prepareNormalizedSource;
 *   copyFile?: (src: string, dst: string) => void;
 *   fileExists?: (path: string) => boolean;
 * }} opts
 * @returns {{ staged: number; realCount: number; skipped: number; logs: string[]; entries: StrumStageRecord[] }}
 */
export function stageGuitarStrums(opts) {
  const {
    entries,
    chordsAbsDir,
    fxAbsDir,
    tempDir,
    normalizeCacheDir,
    log = (m) => console.error(m),
    prepareNormalized = prepareNormalizedSource,
    copyFile = copyFileSync,
    fileExists = existsSync,
  } = opts;

  /** @type {string[]} */
  const logs = [];
  const emit = (m) => { logs.push(m); log(m); };

  /** @type {StrumStageRecord[]} */
  const records = [];
  let realCount = 0;
  let skipped = 0;

  for (const e of entries ?? []) {
    // 54y — fx entries route to <preset>/fx/<fxN>.mp3.
    const isFx = typeof e.fx === 'string' && /^fx\d+$/.test(e.fx);
    let basename;
    let src;
    if (isFx) {
      if (!fxAbsDir) {
        emit(`[prestage] strum#${e.id} SKIP — fx entry but no fxAbsDir supplied`);
        records.push({
          entryId: e.id,
          chord: e.chord,
          chordPosition: String(e.chordPosition),
          type: e.type,
          kind: 'no-source',
          fallbackReason: `fx entry "${e.fx}" but caller did not supply fxAbsDir`,
        });
        skipped++;
        continue;
      }
      basename = `${e.fx}.mp3`;
      src = join(fxAbsDir, basename);
    } else {
      basename = chordFileBasename(e);
      if (!basename) {
        emit(`[prestage] strum#${e.id} SKIP — cannot derive filename for (${e.chord}, ${e.chordPosition}, ${e.type})`);
        records.push({
          entryId: e.id,
          chord: e.chord,
          chordPosition: String(e.chordPosition),
          type: e.type,
          kind: 'no-source',
          fallbackReason: `unsupported type "${e.type}" — expected chord(Long|Short)Strum(Up|Down)`,
        });
        skipped++;
        continue;
      }
      src = join(chordsAbsDir, basename);
    }
    if (!fileExists(src)) {
      emit(`[prestage] strum#${e.id} SKIP — chord file not on disk: ${src}`);
      records.push({
        entryId: e.id,
        chord: e.chord,
        chordPosition: String(e.chordPosition),
        type: e.type,
        kind: 'no-source',
        sourcePath: src,
        fallbackReason: `chord file ${basename} not found in ${chordsAbsDir}`,
      });
      skipped++;
      continue;
    }
    const norm = prepareNormalized({ sourcePath: src, cacheDir: normalizeCacheDir });
    emit(formatNormalizationLog(norm, src));
    if (norm.kind !== 'copy' && norm.kind !== 'transcoded') {
      emit(`[prestage] strum#${e.id} SKIP — normalisation failed (${norm.kind})`);
      records.push({
        entryId: e.id,
        chord: e.chord,
        chordPosition: String(e.chordPosition),
        type: e.type,
        kind: 'no-source',
        sourcePath: src,
        fallbackReason: `normalisation failed: ${norm.kind}`,
      });
      skipped++;
      continue;
    }
    const dst = join(tempDir, `playsample-${e.id}.ogg`);
    copyFile(norm.preparedPath, dst);
    emit(`[prestage] strum#${e.id} (${e.chord}/${e.chordPosition}/${e.type}) ← ${basename} → ${dst}`);
    records.push({
      entryId: e.id,
      chord: e.chord,
      chordPosition: String(e.chordPosition),
      type: e.type,
      kind: 'real-strum',
      sourcePath: src,
      stagedSourcePath: norm.preparedPath,
    });
    realCount++;
  }

  emit(`[prestage] guitar strums summary: ${realCount}/${entries?.length ?? 0} real, ${skipped} skipped`);
  return { staged: realCount, realCount, skipped, logs, entries: records };
}
