// docs/56d — All-genre emit-brain-roundtrip smoke.
//
// For every canonical brain genre (mirrors
// packages/arrangement/test/all-genre-coverage.spec.ts) drive
// `scripts/emit-brain-roundtrip.mjs` with the SEED env var and assert
// the emitted brain Song is parseSong-valid and byte-stable across
// repeated emits at the same seed. Does NOT render — the native
// binary isn't a test dependency.
//
// The render half lives in `apps/engine-spike/scripts/render-all-genres.mjs`
// — run that script manually to populate
// `out/all-genre-render-smoke/<genre>/out.wav` + `summary.json`. The
// schema of `summary.json` is pinned by all-genre-summary-parse.spec.ts.
//
// The 4-genre minimum-viable representative set
// (brightPop / edm / organicVibes / schlager) covers: full roster
// (brightPop), full-edm-pool (edm), fallback-drums-bass-on-non-edm
// (organicVibes), and narrow-roster-with-fallback (schlager).
// SLOW=1 expands to all 8 genres including ballad / latin / rock / urban.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { canonicalStringifySong, contentHash, parseSong } from '@casperaki/song-schema';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const EMIT = resolve(ROOT, 'scripts/emit-brain-roundtrip.mjs');

const CANONICAL_GENRES = [
  'ballad',
  'brightPop',
  'edm',
  'latin',
  'organicVibes',
  'rock',
  'schlager',
  'urban',
] as const;

const FAST_GENRES: ReadonlyArray<(typeof CANONICAL_GENRES)[number]> = [
  'brightPop',
  'edm',
  'organicVibes',
  'schlager',
];

const GENRES = process.env.SLOW === '1' ? CANONICAL_GENRES : FAST_GENRES;

function runEmitToTempDir(genre: string): string {
  const tmp = mkdtempSync(join(tmpdir(), `casperaki-allgenre-${genre}-`));
  try {
    execFileSync(process.execPath, [EMIT], {
      stdio: 'pipe',
      env: { ...process.env, SEED: genre, OUT_DIR: tmp },
    });
    return tmp;
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
}

describe('all-genre emit-brain-roundtrip smoke (docs/56d)', () => {
  for (const genre of GENRES) {
    describe(genre, () => {
      it('emit-brain-roundtrip produces the canonical artefact set', () => {
        const tmp = runEmitToTempDir(genre);
        try {
          for (const name of ['song.json', 'brain-song.json', 'brain-hash.txt', 'asset-manifest.json']) {
            expect(existsSync(join(tmp, name)), `${genre}: missing ${name}`).toBe(true);
          }
        } finally {
          rmSync(tmp, { recursive: true, force: true });
        }
      });

      it('emitted brain Song is parseSong-valid + hash matches brain-hash.txt', () => {
        const tmp = runEmitToTempDir(genre);
        try {
          const raw = readFileSync(join(tmp, 'brain-song.json'), 'utf-8');
          const song = parseSong(JSON.parse(raw));
          expect(song.genre).toBe(genre);
          const hash = contentHash(song);
          const storedHash = readFileSync(join(tmp, 'brain-hash.txt'), 'utf-8').trim();
          expect(hash).toBe(storedHash);
        } finally {
          rmSync(tmp, { recursive: true, force: true });
        }
      });

      it('same SEED → byte-stable canonical Song hash across emits', () => {
        const a = runEmitToTempDir(genre);
        const b = runEmitToTempDir(genre);
        try {
          const hashA = readFileSync(join(a, 'brain-hash.txt'), 'utf-8').trim();
          const hashB = readFileSync(join(b, 'brain-hash.txt'), 'utf-8').trim();
          expect(hashA).toBe(hashB);
          // And canonicalStringifySong of the parsed Songs agrees too.
          const songA = parseSong(JSON.parse(readFileSync(join(a, 'brain-song.json'), 'utf-8')));
          const songB = parseSong(JSON.parse(readFileSync(join(b, 'brain-song.json'), 'utf-8')));
          expect(canonicalStringifySong(songA, 2)).toBe(canonicalStringifySong(songB, 2));
        } finally {
          rmSync(a, { recursive: true, force: true });
          rmSync(b, { recursive: true, force: true });
        }
      });
    });
  }
});
