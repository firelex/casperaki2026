// Song artwork (src/artwork/tasks.ts): a generated song's picture is described by the language model from its title
// and drawn by the image service in the background; the card gets its URL, the event stream announces it, deleting the
// song deletes the picture, and a failure says why.

import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ArtworkTasks, artworkBrief, type ImageService } from '../src/artwork/tasks.js';
import { createApp } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import type { ChatModel } from '../src/llm/chatModel.js';
import { openSongsStore } from '../src/store.js';

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

/** A picture description for the artwork brief. */
function model(prompts: string[]): ChatModel {
  return {
    complete: async (messages) => {
      const text = messages.at(-1)!.content;
      if (!text.includes('cover artwork')) throw new Error(`unexpected prompt: ${text.slice(0, 80)}`);
      prompts.push(text);
      return JSON.stringify({ description: 'a neon city street at night in the rain' });
    },
  };
}

interface Project { id: string; artwork: { state: string; url?: string; message?: string } | null }

async function boot(images: ImageService, prompts: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'artwork-spec-'));
  const store = openSongsStore({ path: ':memory:' });
  const app = createApp(loadConfig({ BRAIN_ARTWORK_DIR: dir } as unknown as NodeJS.ProcessEnv), { store, chatModel: model(prompts), imageService: images });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const tasks = (app.locals as { artworkTasks: ArtworkTasks }).artworkTasks;
  const projects = async () => ((await (await fetch(`${url}/api/songs`)).json()) as { projects: Project[] }).projects;
  return { dir, url, tasks, projects, stop: () => new Promise<void>((r) => server.close(() => { store.close(); r(); })) };
}

const generate = (url: string) =>
  fetch(`${url}/api/songs/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ genre: 'edm', key: 'A', bpm: 124, seed: 'art', title: 'Neon Rain' }) });

describe('song artwork', () => {
  let stop: (() => Promise<void>) | undefined;
  afterEach(async () => { await stop?.(); stop = undefined; });

  it('draws a picture for the title, serves it on the card, and deletes it with the song', async () => {
    const drawn: { prompt: string; seed: number }[] = [];
    const prompts: string[] = [];
    const h = await boot({ draw: async (prompt, seed) => { drawn.push({ prompt, seed }); return PNG; } }, prompts);
    stop = h.stop;
    const made = (await (await generate(h.url)).json()) as { project: Project };
    expect(made.project.artwork).toEqual({ state: 'drawing' });
    await h.tasks.idle();
    expect(prompts[0]).toContain('"Neon Rain"');
    expect(prompts[0]).toContain('an energetic electronic dance track');
    expect(drawn[0]!.prompt).toMatch(/^a neon city street at night in the rain, abstract cyber album cover art/u);
    const [p] = await h.projects();
    expect(p!.artwork).toEqual({ state: 'done', url: expect.stringMatching(new RegExp(`^/api/songs/${p!.id}/artwork\\?v=`, 'u')) });
    const img = await fetch(`${h.url}${p!.artwork!.url}`);
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await img.arrayBuffer())).toEqual(PNG);
    expect(readdirSync(h.dir)).toHaveLength(1);
    expect((await fetch(`${h.url}/api/songs/${p!.id}`, { method: 'DELETE' })).status).toBe(204);
    expect(readdirSync(h.dir)).toHaveLength(0);
  });

  it('says why drawing failed', async () => {
    const h = await boot({ draw: async () => { throw new Error('the image service is down'); } }, []);
    stop = h.stop;
    await generate(h.url);
    await h.tasks.idle();
    const [p] = await h.projects();
    expect(p!.artwork).toEqual({ state: 'failed', message: 'the image service is down' });
    expect((await fetch(`${h.url}/api/songs/${p!.id}/artwork`)).status).toBe(404);
    expect(existsSync(h.dir)).toBe(true);
  });

  it('asks in plain words, naming the style', () => {
    expect(artworkBrief('Velvet Static', 'ballad')).toMatch(/song called "Velvet Static", which is a slow, emotional ballad\./u);
    // abstract and cyber, not a literal scene (owner 2026-11-28: "some of them don't fully fit")
    expect(artworkBrief('Velvet Static', 'ballad')).toMatch(/abstract, futuristic/u);
    expect(artworkBrief('Velvet Static', 'ballad')).toMatch(/not a literal scene/u);
    expect(() => artworkBrief('X', 'polka')).toThrow(/no description for the style "polka"/u);
  });
});
