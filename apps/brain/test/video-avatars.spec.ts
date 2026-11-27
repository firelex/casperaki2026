// The avatars a dance floor video shows (src/avatars/videoAvatars.ts): the chosen ones in order, the lead being the
// first whose voice sang the song's latest finished Sing, and the refusals.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { UserAvatars } from '../src/avatars/userAvatars.js';
import { videoAvatars } from '../src/avatars/videoAvatars.js';
import type { SongsStore } from '../src/store.js';
import { checkStoryboard } from '../src/video/videoInput.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const recipe = { pack: 'drophunter', parts: { body: '0', eyes: 'regulareyes' }, textures: {}, colors: {} };
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function setup(tasks: { kind: string; songId: string; state: string; options: unknown }[]) {
  const dir = mkdtempSync(join(tmpdir(), 'video-avatars-'));
  dirs.push(dir);
  const avatars = new UserAvatars(dir);
  const kai = avatars.save('me', { name: 'Kai', recipe, singerId: 'nova' }, PNG, 't1');
  const ana = avatars.save('me', { name: 'Ana', recipe, singerId: 'singer1' }, PNG, 't2');
  const bo = avatars.save('me', { name: 'Bo', recipe, singerId: null }, PNG, 't3');
  const store = { listTasks: () => tasks } as unknown as SongsStore;
  return { avatars, store, kai, ana, bo };
}

describe('videoAvatars', () => {
  it("makes the avatar with the song's latest singer the lead, keeping the chosen order", () => {
    const { avatars, store, kai, ana, bo } = setup([
      { kind: 'sing', songId: 'other', state: 'done', options: { singerId: 'nova' } },
      { kind: 'sing', songId: 's1', state: 'failed', options: { singerId: 'nova' } },
      { kind: 'sing', songId: 's1', state: 'done', options: { singerId: 'singer1' } },
    ]);
    const out = videoAvatars(store, avatars, 'me', 's1', [bo.id, kai.id, ana.id]);
    expect(out.map((a) => [a.name, a.sings])).toEqual([['Bo', false], ['Kai', false], ['Ana', true]]);
  });

  it('has nobody sing when the song was never sung or no chosen avatar has its singer', () => {
    const { avatars, store, kai, bo } = setup([{ kind: 'sing', songId: 's1', state: 'done', options: { singerId: 'singer1' } }]);
    expect(videoAvatars(store, avatars, 'me', 's1', [kai.id, bo.id]).some((a) => a.sings)).toBe(false);
    expect(videoAvatars(store, avatars, 'me', 's2', [kai.id]).some((a) => a.sings)).toBe(false);
  });

  it('refuses no avatars, too many, one chosen twice, and an unknown one', () => {
    const { avatars, store, kai } = setup([]);
    expect(() => videoAvatars(store, avatars, 'me', 's1', [])).toThrow(/at least one avatar/u);
    expect(() => videoAvatars(store, avatars, 'me', 's1', Array(6).fill(kai.id))).toThrow(/at most 5/u);
    expect(() => videoAvatars(store, avatars, 'me', 's1', [kai.id, kai.id])).toThrow(/chosen twice/u);
    expect(() => videoAvatars(store, avatars, 'me', 's1', ['a-000000000000'])).toThrow(/no avatar "a-000000000000"/u);
    expect(() => videoAvatars(store, avatars, 'someone-else', 's1', [kai.id])).toThrow(/no avatar/u);
  });
});

describe('checkStoryboard', () => {
  const sections = [{ name: 'Intro' }, { name: 'Chorus 1' }];
  const scenes = ['club', 'stage'];
  const cameras = ['auto', 'wide'];
  const ok = [
    { scene: 'club', avatarIds: ['a-1'], camera: 'auto' },
    { scene: 'stage', avatarIds: ['a-1', 'a-2'], camera: 'wide' },
  ];
  it('accepts one entry per section with known scenes, cameras and the video’s avatars', () => {
    expect(() => checkStoryboard(ok, sections, ['a-1', 'a-2'], scenes, cameras)).not.toThrow();
  });
  it('refuses the wrong length, unknown scene or camera, no avatars, repeats and strangers, naming the section', () => {
    const bad = (sb: typeof ok, m: RegExp) => expect(() => checkStoryboard(sb, sections, ['a-1', 'a-2'], scenes, cameras)).toThrow(m);
    bad([ok[0]!], /1 sections, the song 2/u);
    bad([ok[0]!, { ...ok[1]!, scene: 'moon' }], /Chorus 1: there is no scene "moon"/u);
    bad([{ ...ok[0]!, camera: 'drone' }, ok[1]!], /Intro: there is no camera "drone"/u);
    bad([{ ...ok[0]!, avatarIds: [] }, ok[1]!], /Intro: choose at least one avatar/u);
    bad([{ ...ok[0]!, avatarIds: ['a-1', 'a-1'] }, ok[1]!], /listed twice/u);
    bad([{ ...ok[0]!, avatarIds: ['a-9'] }, ok[1]!], /"a-9" is not one of the video's avatars/u);
  });
});
