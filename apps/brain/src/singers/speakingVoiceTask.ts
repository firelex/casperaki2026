// Making a singer's speaking voice (src/singers/speakingVoice.ts): as a task of its own (kind speakingVoice, on no
// song: "Make a speaking voice" or "Describe it yourself" on the Singers page) and as the last steps of Add a singer.
// Steps: describe (the language model; not for a voice the user described), the speech service's speaking_voice
// stage (one step per candidate, then the match), speaking (the voice kept).

import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import type { ChatModel } from '../llm/chatModel.js';
import { CancelledError, followJob, writeAtomic } from '../sing/singTask.js';
import type { VocalsClient } from '../sing/vocalsClient.js';
import type { TaskJobs, TaskStep } from '../store.js';
import { DESCRIBED_SEED, describeVoice, medianSungHz, SPEAKING_SEEDS, speakingTestLine, type SpeakingVoice, type SpeakingVoices } from './speakingVoice.js';

/** The speech service's stage, and the subfolder of the task's files folder its step files are kept in. */
export const SPEAKING_STAGE = 'speaking_voice';
export const SPEAKING_FILES_STAGE = 'speaking';

export const SpeakingVoiceOptionsSchema = z
  .object({
    singerId: z.string().regex(/^[a-z0-9_-]+$/u),
    /** The singer's name (the task's title). */
    name: z.string().min(1),
    /** The user's own description: used as is (one voice). Absent: described from the singing and matched. */
    description: z.string().min(1).max(300).optional(),
  })
  .strict();
export type SpeakingVoiceOptions = z.infer<typeof SpeakingVoiceOptionsSchema>;

/** The singer a speaking voice is made for. */
export interface SpeakingSinger {
  readonly id: string;
  readonly name: string;
  /** The uploader's (or the built-in list's) words about the voice. */
  readonly description: string;
  /** Absolute paths of its voice reference and SoulX-Singer's description of it. */
  readonly audio: string;
  readonly meta: string;
  readonly builtIn: boolean;
}

/** What making speaking voices needs (bootstrap.ts: SPEECH_SERVICE_URL, the singers' data folder, the language model). */
export interface SpeakingVoiceDeps {
  readonly client: VocalsClient;
  readonly voices: SpeakingVoices;
  readonly chat: ChatModel;
  readonly filesDir: string;
  readonly pollMs: number;
}

export interface SpeakingVoiceContext {
  readonly ownerId: string;
  readonly singer: SpeakingSinger;
  /** The user's own description, if any. */
  readonly description?: string;
  readonly deps: SpeakingVoiceDeps;
  /** The task's own files folder (<BRAIN_TASK_FILES_DIR>/<task id>). */
  readonly filesDir: string;
  readonly signal: AbortSignal;
  readonly jobs: TaskJobs | null;
  readonly setJobs: (jobs: TaskJobs) => void;
  /** The steps so far (the caller may show them after its own). */
  readonly setSteps: (steps: TaskStep[]) => void;
  readonly now: () => string;
}

const ResultSchema = z
  .object({ best_seed: z.number().int(), scores: z.record(z.string(), z.number()), sample: z.string() })
  .strict();

/** Makes and keeps the singer's speaking voice; the earlier one stays until the new one is complete. */
export async function makeSpeakingVoice(ctx: SpeakingVoiceContext): Promise<SpeakingVoice> {
  const { singer, deps } = ctx;
  let describe: TaskStep | undefined = ctx.description ? undefined : { id: 'describe', label: 'Describe the speaking voice', state: 'waiting' };
  let service: TaskStep[] = [];
  let keep: TaskStep = { id: 'speaking', label: 'Keep the speaking voice', state: 'waiting' };
  const publish = () => ctx.setSteps([...(describe ? [describe] : []), ...service, keep]);
  publish();

  // A task resumed after a restart follows its job with the description that job was started with.
  const resumed = ctx.jobs?.speaking !== undefined;
  let description = resumed ? ctx.jobs!.speakingDescription : ctx.description;
  if (resumed && !description) throw new Error('the speaking-voice job lost its description: make the speaking voice again');
  if (resumed && describe) {
    describe = { ...describe, state: 'done', text: description! };
    publish();
  }
  if (!description) {
    const startedAt = ctx.now();
    describe = { ...describe!, state: 'running', startedAt };
    publish();
    try {
      description = await describeVoice(deps.chat, { name: singer.name, description: singer.description, medianHz: medianSungHz(singer.meta) });
    } catch (err) {
      describe = { ...describe, state: 'failed', finishedAt: ctx.now(), text: err instanceof Error ? err.message : String(err) };
      publish();
      throw err;
    }
    describe = { ...describe, state: 'done', finishedAt: ctx.now(), text: description };
    publish();
  }
  const seeds = ctx.description ? [DESCRIBED_SEED] : [...SPEAKING_SEEDS];

  let job: string;
  if (resumed) job = ctx.jobs!.speaking!;
  else {
    if (ctx.signal.aborted) throw new CancelledError();
    // A new job: an earlier run's step files must go, or followJob (which skips files it already has) keeps them.
    rmSync(join(ctx.filesDir, SPEAKING_FILES_STAGE), { recursive: true, force: true });
    job = await deps.client.submit({ stage: SPEAKING_STAGE, singer: singer.name, reference: singer.audio, description, test_line: speakingTestLine(singer.name), seeds, match: !ctx.description });
    ctx.setJobs({ ...(ctx.jobs ?? {}), speaking: job, speakingDescription: description });
  }
  const following = { client: deps.client, filesDir: ctx.filesDir, pollMs: deps.pollMs, signal: ctx.signal };
  const file = await followJob(following, SPEAKING_FILES_STAGE, job, (steps) => {
    service = steps;
    publish();
  });
  const stageDir = join(ctx.filesDir, SPEAKING_FILES_STAGE);
  writeAtomic(join(stageDir, 'speaking_voice.json'), file);
  const result = ResultSchema.parse(JSON.parse(file.toString('utf8')));

  const startedAt = ctx.now();
  keep = { ...keep, state: 'running', startedAt };
  publish();
  try {
    const voice: SpeakingVoice = {
      description,
      seed: result.best_seed,
      sample: 'speaking.wav',
      madeBy: ctx.description ? 'described' : 'matched',
      line: speakingTestLine(singer.name),
      candidates: seeds.map((seed) => {
        if (ctx.description) return { seed, score: null };
        const score = result.scores[String(seed)];
        if (score === undefined) throw new Error(`the speech service gave no score for candidate ${seed}`);
        return { seed, score };
      }),
      createdAt: ctx.now(),
    };
    deps.voices.save(ctx.ownerId, singer.id, singer.builtIn, voice, new Map(seeds.map((s) => [s, join(stageDir, `candidate-${s}.wav`)])));
    keep = { ...keep, state: 'done', finishedAt: ctx.now(), text: `${singer.name} speaks in voice ${voice.seed}` };
    publish();
    return voice;
  } catch (err) {
    keep = { ...keep, state: 'failed', finishedAt: ctx.now(), text: err instanceof Error ? err.message : String(err) };
    publish();
    throw err;
  }
}
