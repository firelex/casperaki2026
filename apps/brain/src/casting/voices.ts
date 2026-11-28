// Speaking a casting script: every line in its character's voice (docs/superpowers/plans/2026-11-28-casting-4-
// soundtrack.md): the narrator's and the judges' approved descriptions and seeds, the singer's own speaking voice.
// The voice is the description alone: adding the line's delivery note to it changed the person in a test (ledger).

import { join } from 'node:path';

import { z } from 'zod';

import { CancelledError, followJob } from '../sing/singTask.js';
import type { VocalsClient } from '../sing/vocalsClient.js';
import type { TaskJobs, TaskStep } from '../store.js';
import { JUDGES, NARRATOR_VOICE } from './cast.js';
import { SCENES, type CastingScript, type Speaker } from './writer.js';

export interface Voice {
  readonly description: string;
  readonly seed: number;
}
export interface LineRequest {
  /** "<scene>-<n>", n from 1 in the scene. */
  readonly id: string;
  readonly text: string;
  readonly instruction: string;
  readonly seed: number;
}

export const VOICES_STAGE = 'voices';

function voiceOf(speaker: Speaker, singer: Voice): Voice {
  if (speaker === 'narrator') return NARRATOR_VOICE;
  if (speaker === 'singer') return singer;
  return JUDGES.find((j) => j.id === speaker)!.voice;
}

/** The speech service's request for every line of the script, in order. */
export function lineVoices(script: CastingScript, singer: Voice): LineRequest[] {
  return SCENES.flatMap((scene) =>
    script[scene].map((l, i) => {
      const v = voiceOf(l.speaker, singer);
      return { id: `${scene}-${i + 1}`, text: l.text, instruction: v.description, seed: v.seed };
    }),
  );
}

export interface SpeakContext {
  readonly client: VocalsClient;
  /** The task's own files folder. */
  readonly filesDir: string;
  readonly pollMs: number;
  readonly signal: AbortSignal;
  readonly jobs: TaskJobs | null;
  readonly setJobs: (jobs: TaskJobs) => void;
  readonly setSteps: (steps: TaskStep[]) => void;
}

const ResultSchema = z.object({ lines: z.array(z.object({ id: z.string(), file: z.string(), seconds: z.number().positive() })) });

/** Has the speech service speak the lines (its `lines` stage); each line's WAV is kept in <filesDir>/voices. */
export async function speakLines(ctx: SpeakContext, requests: readonly LineRequest[]): Promise<Map<string, { file: string; seconds: number }>> {
  let job: string;
  if (ctx.jobs?.castingVoices !== undefined) job = ctx.jobs.castingVoices;
  else {
    if (ctx.signal.aborted) throw new CancelledError();
    job = await ctx.client.submit({ stage: 'lines', lines: requests });
    ctx.setJobs({ ...(ctx.jobs ?? {}), castingVoices: job });
  }
  const file = await followJob({ client: ctx.client, filesDir: ctx.filesDir, pollMs: ctx.pollMs, signal: ctx.signal }, VOICES_STAGE, job, ctx.setSteps);
  const result = ResultSchema.parse(JSON.parse(file.toString('utf8')));
  const out = new Map<string, { file: string; seconds: number }>();
  for (const r of requests) {
    const got = result.lines.find((l) => l.id === r.id);
    if (!got) throw new Error(`casting: the speech service did not speak the line ${r.id} ("${r.text.slice(0, 40)}")`);
    out.set(r.id, { file: join(ctx.filesDir, VOICES_STAGE, got.file), seconds: got.seconds });
  }
  return out;
}
