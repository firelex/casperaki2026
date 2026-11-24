// Song artwork, drawn in the background for the song's card. When a song is generated, it waits for the song's title
// (the language model names new songs, src/titles), asks the language model to describe a picture for that title,
// and has the image service (svc-artwork: segmind/small-sd on the serving harness) draw it. The project's artwork
// state is kept in the database ("drawing", "done" with its file, or "failed" with why), follows the project when
// saves move it, and unfinished tasks resume when the brain starts. A finished or failed picture is announced on
// /api/events.

import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { EventHub } from '../events.js';
import type { ChatModel } from '../llm/chatModel.js';
import type { SongsStore } from '../store.js';

/** Draws an image from a description (the serving harness's job API). */
export interface ImageService {
  draw(prompt: string, seed: number): Promise<Buffer>;
}

export interface ArtworkTasksDeps {
  readonly store: SongsStore;
  readonly model: ChatModel;
  readonly images: ImageService;
  readonly events: EventHub;
  /** Where the pictures are kept (one PNG per task). */
  readonly dir: string;
}

/** The song styles in plain words, for the picture's mood. */
const STYLE: Record<string, string> = {
  ballad: 'a slow, emotional ballad',
  brightPop: 'a bright, upbeat pop song',
  edm: 'an energetic electronic dance track',
  latin: 'a warm, rhythmic Latin song',
  organicVibes: 'a relaxed, organic, acoustic-flavoured song',
  rock: 'a driving rock song',
  schlager: 'a cheerful German schlager song',
  urban: 'a smooth urban hip-hop and R&B track',
};

/** Added to every description: the look of a cover, and what the small model draws well. */
const LOOK = 'album cover art, digital painting, rich colours, dramatic lighting, highly detailed';

export function artworkBrief(title: string, genre: string | null): string {
  const style = genre ? STYLE[genre] : undefined;
  if (genre && !style) throw new Error(`artworkBrief: no description for the style "${genre}"`);
  return [
    `Describe a picture to use as the cover artwork of a song called "${title}"${style ? `, which is ${style}` : ''}.`,
    'A small image-generation model will draw it from your description, so describe one clear scene or subject in',
    'concrete visual terms: what is in the picture, where it is, the colours, the light and the mood. Let the title',
    'inspire it, but do not ask for any text, letters, words or logos in the picture, and do not name real people,',
    'artists or brands.',
    'The description is one sentence of at most 40 words.',
    'Answer in JSON of the form {"description": "..."}.',
  ].join(' ');
}

export class ArtworkTasks {
  private readonly running = new Map<string, Promise<void>>();

  constructor(private readonly deps: ArtworkTasksDeps) {
    mkdirSync(deps.dir, { recursive: true });
  }

  /** Starts drawing a project's artwork once `titled` settles (the song has its final title then). */
  start(ownerId: string, songId: string, titled: Promise<unknown> = Promise.resolve()): void {
    const task = randomUUID();
    if (!this.deps.store.setProjectArtwork({ ownerId, songId, artwork: { state: 'drawing', task } })) {
      throw new Error(`ArtworkTasks.start: no project ${songId} for this owner`);
    }
    // The title is the titler's business: drawing goes ahead with whatever title the song has once naming is over.
    this.launch(ownerId, task, titled.then(() => undefined, () => undefined));
  }

  /** Resumes every task the database says is still drawing (at start-up: a restart ended them). */
  resumeAll(): void {
    for (const p of this.deps.store.listDrawingArtwork()) {
      if (p.artwork?.state !== 'drawing') throw new Error(`ArtworkTasks.resumeAll: project ${p.songId} is not drawing`);
      if (!this.running.has(p.artwork.task)) this.launch(p.ownerId, p.artwork.task, Promise.resolve());
    }
  }

  /** The path of a drawn picture. */
  fileOf(file: string): string {
    if (!/^[\w-]+\.png$/u.test(file)) throw new Error(`ArtworkTasks.fileOf: not an artwork file name: ${file}`);
    return join(this.deps.dir, file);
  }

  /** Deletes a drawn picture (its song was deleted). */
  removeFile(file: string): void {
    rmSync(this.fileOf(file), { force: true });
  }

  /** Resolves when every running task has finished (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running.values()]);
  }

  private launch(ownerId: string, task: string, titled: Promise<void>): void {
    const run = titled.then(() => this.run(ownerId, task)).finally(() => this.running.delete(task));
    this.running.set(task, run);
  }

  private async run(ownerId: string, task: string): Promise<void> {
    const { store, model, images, events, dir } = this.deps;
    const at = store.projectOfArtworkTask(ownerId, task);
    if (!at) return; // deleted meanwhile
    try {
      const answer = await model.complete([{ role: 'user', content: artworkBrief(at.title, at.genre) }], { thinking: false });
      const description = (JSON.parse(answer) as { description?: unknown }).description;
      if (typeof description !== 'string' || !description.trim()) throw new Error(`the language model described no picture: ${answer.slice(0, 200)}`);
      const png = await images.draw(`${description.trim()}, ${LOOK}`, seedOf(task));
      const file = `${task}.png`;
      writeFileSync(join(dir, file), png);
      const now = store.projectOfArtworkTask(ownerId, task);
      if (!now) return;
      store.setProjectArtwork({ ownerId, songId: now.songId, artwork: { state: 'done', task, file } });
      events.publish(ownerId, { type: 'artwork', state: 'done', songId: now.songId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[artwork] task ${task} failed: ${message}`);
      const now = store.projectOfArtworkTask(ownerId, task);
      if (!now) return;
      store.setProjectArtwork({ ownerId, songId: now.songId, artwork: { state: 'failed', task, message } });
      events.publish(ownerId, { type: 'artwork', state: 'failed', songId: now.songId, message });
    }
  }
}

/** A seed from the task id: the same task draws the same picture. */
function seedOf(task: string): number {
  return Number.parseInt(task.replace(/-/gu, '').slice(0, 8), 16);
}

const POLL_MS = 1000;
const TIMEOUT_MS = 5 * 60_000;

/** The serving harness's job API (apps/models/services/_serving/harness.py): POST /generate, GET /result, GET /file. */
export class HarnessImageService implements ImageService {
  constructor(private readonly baseUrl: string) {}

  async draw(prompt: string, seed: number): Promise<Buffer> {
    const base = this.baseUrl.replace(/\/+$/u, '');
    const submit = await fetch(`${base}/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, seed, steps: 25, size: 512 }),
    });
    if (submit.status !== 202) throw new Error(`the image service answered ${submit.status}: ${await submit.text()}`);
    const { job_id: job } = (await submit.json()) as { job_id: string };
    const deadline = Date.now() + TIMEOUT_MS;
    for (;;) {
      if (Date.now() > deadline) throw new Error(`the image service did not finish job ${job} within ${TIMEOUT_MS / 1000} s`);
      await new Promise((r) => setTimeout(r, POLL_MS));
      const res = (await (await fetch(`${base}/result?job=${encodeURIComponent(job)}`)).json()) as { state: string; error?: string | null };
      if (res.state === 'error') throw new Error(`the image service failed: ${res.error ?? 'no reason given'}`);
      if (res.state === 'done') break;
    }
    const file = await fetch(`${base}/file?job=${encodeURIComponent(job)}`);
    if (!file.ok) throw new Error(`the image service answered ${file.status} for the picture of job ${job}`);
    return Buffer.from(await file.arrayBuffer());
  }
}
