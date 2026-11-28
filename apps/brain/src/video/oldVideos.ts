// The console and 2D cartoon videos were removed (2026-11-28, docs/superpowers/plans/2026-11-28-casting-2-3d-only.md):
// their files in each song's video folder are deleted once, at brain start. The avatar videos (avatars-*,
// status-avatars-*) stay.

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** The old cartoon (<format>.mp4, status-<format>.json, plan.json, plan-<format>.json) and console (console-*,
 *  status-console-*) files. */
const OLD = [/^(landscape|portrait)(-preview)?\.mp4$/u, /^status-(landscape|portrait)(-preview)?\.json$/u, /^plan(-[a-z-]+)?\.json$/u, /^console-/u, /^status-console-/u];

/** Deletes the old video files in every song folder of `videosDir` (a folder named by a song id). */
export function removeOldVideos(videosDir: string): { removed: number } {
  if (!existsSync(videosDir)) return { removed: 0 };
  let removed = 0;
  for (const song of readdirSync(videosDir)) {
    const dir = join(videosDir, song);
    if (!/^[0-9a-f]{16}$/u.test(song) || !statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir)) {
      if (!OLD.some((r) => r.test(f))) continue;
      rmSync(join(dir, f), { force: true });
      removed++;
    }
  }
  return { removed };
}
