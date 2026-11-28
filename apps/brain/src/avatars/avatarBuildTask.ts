// Building a realistic avatar (docs/superpowers/specs/2026-11-28-realistic-avatars-design.md): a background task of
// its own (kind avatarBuild, on no song, admins only) that asks the avatar builder (AVATAR_BUILDER_URL) to build the
// design and keeps the person it made in the task's files folder (<filesDir>/<task id>/build/person.vrm), where Save
// takes it from. Builds are swept a day after they end (sweepOldBuilds): a saved avatar has its own copy.

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { CancelledError, followJob } from '../sing/singTask.js';
import type { VocalsClient } from '../sing/vocalsClient.js';
import type { TaskJobs, TaskStep } from '../store.js';
import { type RealisticDesign, type RealisticLibrary } from './realisticDesign.js';

/** The builder's stage, and the subfolder of the task's files folder its files are kept in. */
export const BUILD_STAGE = 'build';
/** How long a build's files are kept after it ends. */
export const BUILD_KEEP_MS = 24 * 60 * 60 * 1000;

export interface AvatarBuildDeps {
  readonly client: VocalsClient;
  readonly library: RealisticLibrary;
  /** Where build tasks keep their files (<BRAIN_TASK_FILES_DIR>/avatar-builds). */
  readonly filesDir: string;
  readonly pollMs: number;
}

const ResultSchema = z
  .object({ bytes: z.number().int().positive(), credits: z.array(z.object({ name: z.string(), author: z.string(), licence: z.string() }).passthrough()) })
  .passthrough();
export type AvatarBuildResult = { bytes: number; credits: { name: string; author: string; licence: string }[] };

export interface AvatarBuildContext {
  readonly design: RealisticDesign;
  readonly deps: AvatarBuildDeps;
  /** The task's own files folder (<filesDir>/<task id>). */
  readonly filesDir: string;
  readonly signal: AbortSignal;
  readonly jobs: TaskJobs | null;
  readonly setJobs: (jobs: TaskJobs) => void;
  readonly setSteps: (steps: TaskStep[]) => void;
}

/** The built person of a finished build task. */
export function builtVrm(filesDir: string, taskId: string): string {
  return join(filesDir, taskId, BUILD_STAGE, 'person.vrm');
}

export async function buildAvatar(ctx: AvatarBuildContext): Promise<AvatarBuildResult> {
  const { deps } = ctx;
  let job: string;
  if (ctx.jobs?.avatarBuild !== undefined) job = ctx.jobs.avatarBuild;
  else {
    if (ctx.signal.aborted) throw new CancelledError();
    rmSync(join(ctx.filesDir, BUILD_STAGE), { recursive: true, force: true });
    job = await deps.client.submit({ stage: BUILD_STAGE, design: ctx.design });
    ctx.setJobs({ ...(ctx.jobs ?? {}), avatarBuild: job });
  }
  const file = await followJob({ client: deps.client, filesDir: ctx.filesDir, pollMs: deps.pollMs, signal: ctx.signal }, BUILD_STAGE, job, ctx.setSteps);
  const result = ResultSchema.parse(JSON.parse(file.toString('utf8')));
  if (!existsSync(join(ctx.filesDir, BUILD_STAGE, 'person.vrm'))) throw new Error('the avatar builder finished without the person (person.vrm)');
  return { bytes: result.bytes, credits: result.credits.map(({ name, author, licence }) => ({ name, author, licence })) };
}

/** Deletes build folders (one per task) not changed for BUILD_KEEP_MS. */
export function sweepOldBuilds(filesDir: string, nowMs: number): string[] {
  if (!existsSync(filesDir)) return [];
  const gone: string[] = [];
  for (const name of readdirSync(filesDir)) {
    const path = join(filesDir, name);
    if (nowMs - statSync(path).mtimeMs > BUILD_KEEP_MS) {
      rmSync(path, { recursive: true, force: true });
      gone.push(name);
    }
  }
  return gone;
}
