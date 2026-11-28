// The console and 2D cartoon videos are gone: their old files are removed once at brain start (src/video/oldVideos.ts);
// the avatar videos stay.

import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { removeOldVideos } from '../src/video/oldVideos.js';

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('removeOldVideos', () => {
  it('removes the cartoon and console files and keeps the avatar videos', () => {
    dir = mkdtempSync(join(tmpdir(), 'old-videos-'));
    const song = join(dir, '0123456789abcdef');
    mkdirSync(song);
    const old = ['landscape.mp4', 'status-landscape.json', 'portrait-preview.mp4', 'plan.json', 'plan-portrait.json', 'console-portrait.mp4', 'status-console-portrait.json', 'console-input-portrait.json'];
    const kept = ['avatars-landscape.mp4', 'status-avatars-landscape.json', 'avatars-input-landscape.json'];
    for (const f of [...old, ...kept]) writeFileSync(join(song, f), 'x');
    writeFileSync(join(dir, 'not-a-song.txt'), 'x');
    expect(removeOldVideos(dir)).toEqual({ removed: old.length });
    expect(readdirSync(song).sort()).toEqual([...kept].sort());
    expect(readdirSync(dir).sort()).toEqual(['0123456789abcdef', 'not-a-song.txt']);
    expect(removeOldVideos(dir)).toEqual({ removed: 0 });
  });

  it('does nothing when the videos folder does not exist yet', () => {
    dir = mkdtempSync(join(tmpdir(), 'old-videos-'));
    expect(removeOldVideos(join(dir, 'missing'))).toEqual({ removed: 0 });
  });
});
