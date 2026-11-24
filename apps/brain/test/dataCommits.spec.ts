// Decisions made in the app are recorded in git: pattern-lab reviews export the
// pattern library and commit it, melody edits commit their file. Uses throwaway
// repos with a bare remote, set up like the real ones.

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { loadPatternProposals, PATTERN_LIBRARY_DIRS } from '@casperaki/arrangement';

import { createApp } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { commitAndPush } from '../src/git.js';
import { MelodyEdits, type StoredEdit } from '../src/melodies/melodyEdits.js';
import { openSongsStore } from '../src/store.js';
import { fakePlayback } from './fakePlayback.js';

const tmp = mkdtempSync(join(tmpdir(), 'casperaki-data-commits-'));
afterAll(() => rmSync(tmp, { recursive: true }));

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** A repo with one commit, pushed to a bare remote. */
function repo(name: string, fill: (dir: string) => void): string {
  const dir = join(tmp, name);
  const remote = join(tmp, `${name}-remote.git`);
  mkdirSync(dir);
  git(tmp, 'init', '-q', '--bare', remote);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  fill(dir);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  git(dir, 'remote', 'add', 'origin', remote);
  git(dir, 'push', '-q', '-u', 'origin', 'main');
  return dir;
}
const pushed = (dir: string) => git(dir, 'log', '--format=%B%x00', 'origin/main').split('\0').map((m) => m.trim()).filter(Boolean);

describe('commitAndPush', () => {
  it('commits only the given paths, pushes, and records nothing when they did not change', () => {
    const dir = repo('plain', (d) => {
      writeFileSync(join(d, 'a.json'), '1\n');
      writeFileSync(join(d, 'other.txt'), 'x\n');
    });
    writeFileSync(join(dir, 'a.json'), '2\n');
    writeFileSync(join(dir, 'other.txt'), 'someone else’s work\n');
    commitAndPush([join(dir, 'a.json')], 'change a');
    expect(pushed(dir)).toEqual(['change a', 'init']);
    expect(git(dir, 'status', '--porcelain')).toBe('M other.txt');
    commitAndPush([join(dir, 'a.json')], 'no change');
    expect(pushed(dir)).toEqual(['change a', 'init']);
  });
});

describe('melody edits', () => {
  it('commit every save and every revert', () => {
    const commits: [string, string][] = [];
    const path = join(tmp, 'melody-edits.json');
    const edits = new MelodyEdits(path, () => {}, (p, m) => commits.push([p, m]));
    const edit: StoredEdit = { melody: {}, chords: {}, useOriginal: true, useRemix: false, source: { kind: 'song' }, editedAt: '2026-11-24T00:00:00Z', editedBy: 'ann' };
    edits.set('drLuke', '18', edit);
    edits.remove('drLuke', '18', 'bob');
    expect(commits).toEqual([
      [path, 'melodies: ann edited drLuke/18'],
      [path, 'melodies: bob reverted drLuke/18 to the stored version'],
    ]);
  });
});

describe('pattern lab reviews', () => {
  it('export the approved patterns into the library and commit them', async () => {
    const lib = repo('library', (d) => {
      for (const k of ['drums', 'bass', 'authored'] as const) cpSync(PATTERN_LIBRARY_DIRS[k], join(d, k), { recursive: true });
    });
    const dirs = { proposals: PATTERN_LIBRARY_DIRS.proposals, drums: join(lib, 'drums'), bass: join(lib, 'bass'), authored: join(lib, 'authored') };
    const store = openSongsStore({ path: ':memory:' });
    const app = createApp(loadConfig({} as NodeJS.ProcessEnv), { store, playback: fakePlayback(), commit: commitAndPush, patternLibraryDirs: dirs });
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const review = async (id: string, status: string) =>
        (await (await fetch(`${url}/api/patterns/${id}/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status }) })).json()) as {
          review: unknown;
          library: string[];
        };
      const p = loadPatternProposals().find((x) => x.family === 'bass')!;
      const approved = await review(p.id, 'approved');
      expect(approved.library.length).toBeGreaterThan(0);
      expect(existsSync(join(dirs.bass, 'authored', `${p.id}.json`))).toBe(true);
      expect(pushed(lib)[0]).toBe(`patterns: local-dev approved ${p.id}\n\n${approved.library.join('\n')}`);

      const rejected = await review(p.id, 'rejected');
      expect(existsSync(join(dirs.bass, 'authored', `${p.id}.json`))).toBe(false);
      expect(JSON.parse(readFileSync(join(dirs.bass, 'bank-index.json'), 'utf8')).authored?.[`authored-${p.id}`]).toBeUndefined();
      expect(pushed(lib)[0]!.startsWith(`patterns: local-dev rejected ${p.id}`)).toBe(true);
      expect(rejected.review).toMatchObject({ status: 'rejected' });
      // Rejecting what is not in the library changes nothing, so nothing is committed.
      const before = pushed(lib).length;
      await review(p.id, 'pending');
      expect(pushed(lib).length).toBe(before);
      expect(git(lib, 'status', '--porcelain')).toBe('');
    } finally {
      await new Promise<void>((resolve) => server.close(() => { store.close(); resolve(); }));
    }
  });
});
