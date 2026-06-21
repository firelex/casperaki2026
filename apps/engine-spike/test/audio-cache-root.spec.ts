// Audio cache-root resolution — docs/54i.
//
// Covers the priority order (env override → /mnt/d default → repo-local
// fallback), and the no-converted-audio-in-tracked-paths invariant: any
// successfully resolved path is either operator-chosen, out-of-repo
// (under /mnt/d), or inside the gitignored `apps/engine-spike/.cache/`.

import { describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resolveAudioCacheRoot,
  formatCacheRootLog,
} from '../scripts/lib/audio-cache-root.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_FALLBACK = resolve(HERE, '../.cache/audio-normalized');

describe('resolveAudioCacheRoot', () => {
  it('honours the CASPERAKI_AUDIO_CACHE_ROOT env value when set', () => {
    const r = resolveAudioCacheRoot({
      envValue: '/some/operator-chosen/cache',
      repoLocalFallback: REPO_FALLBACK,
      fileExists: () => true, // /mnt/d would otherwise win
    });
    expect(r.source).toBe('env');
    expect(r.path).toBe('/some/operator-chosen/cache');
  });

  it('trims whitespace on env values', () => {
    const r = resolveAudioCacheRoot({
      envValue: '   /trimmed/cache   ',
      repoLocalFallback: REPO_FALLBACK,
      fileExists: () => true,
    });
    expect(r.source).toBe('env');
    expect(r.path).toBe('/trimmed/cache');
  });

  it('falls through to /mnt/d default when env is unset and /mnt/d exists', () => {
    const r = resolveAudioCacheRoot({
      envValue: undefined,
      repoLocalFallback: REPO_FALLBACK,
      fileExists: (p) => p === '/mnt/d',
    });
    expect(r.source).toBe('mnt-d-default');
    expect(r.path).toBe('/mnt/d/casperaki-cache/audio-normalized');
  });

  it('honours a custom /mnt/d default path (for test injection)', () => {
    const r = resolveAudioCacheRoot({
      envValue: undefined,
      repoLocalFallback: REPO_FALLBACK,
      fileExists: (p) => p === '/mnt/d',
      mntDDefault: '/mnt/d/casperaki/cache',
    });
    expect(r.path).toBe('/mnt/d/casperaki/cache');
  });

  it('falls back to the repo-local .cache when env is unset and /mnt/d is missing', () => {
    const r = resolveAudioCacheRoot({
      envValue: '',
      repoLocalFallback: REPO_FALLBACK,
      fileExists: () => false,
    });
    expect(r.source).toBe('repo-local-fallback');
    expect(r.path).toBe(REPO_FALLBACK);
    // The fallback path lives under apps/engine-spike/.cache/ which is
    // gitignored — see .gitignore. This protects against writing
    // transcoded audio into a tracked source path.
    expect(r.path).toMatch(/\/apps\/engine-spike\/\.cache\//u);
  });

  it('treats an empty env value the same as unset', () => {
    const r = resolveAudioCacheRoot({
      envValue: '   ',
      repoLocalFallback: REPO_FALLBACK,
      fileExists: () => true,
    });
    expect(r.source).toBe('mnt-d-default');
  });

  it('never points at a tracked engine-spike source dir', () => {
    // Three resolution branches; none of them should land inside
    // tracked paths like apps/engine-spike/samples or scripts.
    const cases = [
      resolveAudioCacheRoot({
        envValue: undefined,
        repoLocalFallback: REPO_FALLBACK,
        fileExists: () => true,
      }),
      resolveAudioCacheRoot({
        envValue: undefined,
        repoLocalFallback: REPO_FALLBACK,
        fileExists: () => false,
      }),
      resolveAudioCacheRoot({
        envValue: '/mnt/d/casperaki-cache/audio-normalized',
        repoLocalFallback: REPO_FALLBACK,
        fileExists: () => true,
      }),
    ];
    for (const r of cases) {
      expect(r.path).not.toContain('/apps/engine-spike/samples');
      expect(r.path).not.toContain('/apps/engine-spike/scripts');
      expect(r.path).not.toContain('/apps/engine-spike/native');
    }
  });
});

describe('formatCacheRootLog', () => {
  it('mentions the path, source, and env var name', () => {
    const line = formatCacheRootLog({
      path: '/tmp/cache',
      source: 'env',
      envVar: 'CASPERAKI_AUDIO_CACHE_ROOT',
    });
    expect(line).toContain('/tmp/cache');
    expect(line).toContain('env');
    expect(line).toContain('CASPERAKI_AUDIO_CACHE_ROOT');
  });
});
