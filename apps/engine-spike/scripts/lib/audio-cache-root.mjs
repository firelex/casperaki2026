// Audio normalisation cache root resolver — docs/54i.
//
// Picks the directory where ffmpeg-transcoded audio (Ogg-Vorbis bytes
// produced from real catalog .mp3 sources) lives. Cache outputs must
// never land inside git-tracked source paths; the resolver enforces
// that by preferring an out-of-repo location.
//
// Priority order:
//   1. `CASPERAKI_AUDIO_CACHE_ROOT` env value (operator override).
//   2. `/mnt/d/casperaki-cache/audio-normalized` when `/mnt/d` exists
//      (the WSL/Dropbox host the operator uses for the sample library
//      already lives on the D: volume; co-locating the cache there is
//      the natural default and is automatically outside the repo tree).
//   3. `apps/engine-spike/.cache/audio-normalized` as a repo-local
//      fallback. The `.cache/` directory is gitignored so cached audio
//      never ends up tracked.

import { existsSync } from 'node:fs';

const MNT_D_DEFAULT = '/mnt/d/casperaki-cache/audio-normalized';

/**
 * @typedef {{
 *   path: string;
 *   source: 'env' | 'mnt-d-default' | 'repo-local-fallback';
 *   envVar: 'CASPERAKI_AUDIO_CACHE_ROOT';
 * }} CacheRootResolution
 */

/**
 * @param {{
 *   envValue?: string | undefined;
 *   repoLocalFallback: string;
 *   fileExists?: (path: string) => boolean;
 *   mntDDefault?: string;
 * }} opts
 * @returns {CacheRootResolution}
 */
export function resolveAudioCacheRoot({
  envValue,
  repoLocalFallback,
  fileExists = existsSync,
  mntDDefault = MNT_D_DEFAULT,
}) {
  if (typeof envValue === 'string' && envValue.trim().length > 0) {
    return {
      path: envValue.trim(),
      source: 'env',
      envVar: 'CASPERAKI_AUDIO_CACHE_ROOT',
    };
  }
  if (fileExists('/mnt/d')) {
    return {
      path: mntDDefault,
      source: 'mnt-d-default',
      envVar: 'CASPERAKI_AUDIO_CACHE_ROOT',
    };
  }
  return {
    path: repoLocalFallback,
    source: 'repo-local-fallback',
    envVar: 'CASPERAKI_AUDIO_CACHE_ROOT',
  };
}

/**
 * @param {CacheRootResolution} r
 */
export function formatCacheRootLog(r) {
  return (
    `[normalize] audio cache root: ${r.path} (source=${r.source}; ` +
    `override via ${r.envVar})`
  );
}
