// Committing data the brain changes (the standard mix, the pattern library,
// melody edits) to git and pushing it at once, so the decisions people make in
// the app are kept in the repos, not only on the server. A failing step throws
// with git's own message.

import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';

/** Commits these files (new, changed or deleted; nothing else) in the repo they are in, then pushes. */
export type Committer = (paths: readonly string[], message: string) => void;

export const commitAndPush: Committer = (paths, message) => {
  if (!paths.length) throw new Error('Nothing to commit: no paths given.');
  const cwd = dirname(paths[0]!);
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args[0]} failed in ${cwd}: ${(r.stderr || r.stdout || r.error?.message || '').trim()}`);
    return r.stdout.trim();
  };
  git('add', '-A', '--', ...paths);
  // Nothing changed (e.g. a decision that leaves the library as it was): nothing to record.
  if (!git('diff', '--cached', '--name-only', '--', ...paths)) return;
  git('commit', '-m', message, '--', ...paths);
  git('push');
};
