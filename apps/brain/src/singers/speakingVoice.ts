// Singers' speaking voices (docs/superpowers/specs/2026-11-28-video-modes-casting-design.md): the voice a singer
// speaks in (casting videos). A voice copied from singing speaks as if singing, so instead the language model
// describes the voice from the singing (its pitch and the uploader's words), the speech service (svc-speech,
// speaking_voice stage) speaks a test line in that described voice with eight seeds and keeps the candidate closest to
// the singer's reference; the user may choose another candidate, or describe the voice themselves (one voice, seed 7).
//
// Kept per owner in the singers' data folder (BRAIN_SINGERS_DATA_DIR), never in the built-in singers' folder:
//
//   <dir>/<owner>/<singer id>/speaking/                 one of the owner's own singers
//   <dir>/<owner>/builtin-speaking/<singer id>/         a built-in singer
//     speaking.json (SpeakingVoice), speaking.wav (the chosen voice saying the test line),
//     candidates/candidate-<seed>.wav

import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { z } from 'zod';

import type { ChatModel } from '../llm/chatModel.js';
import { ownerFolder } from './userSingers.js';

/** The candidate seeds a matched voice is chosen from (the speech service speaks one candidate per seed). */
export const SPEAKING_SEEDS = [7, 11, 21, 33, 42, 57, 64, 99] as const;
/** The seed of a voice the user described. */
export const DESCRIBED_SEED = 7;

export const SpeakingVoiceSchema = z
  .object({
    description: z.string().min(1),
    seed: z.number().int(),
    sample: z.literal('speaking.wav'),
    madeBy: z.enum(['matched', 'described']),
    /** Every candidate spoken, with how close it is to the singing voice (null for a described voice's one). */
    candidates: z.array(z.object({ seed: z.number().int(), score: z.number().nullable() }).strict()).min(1),
    createdAt: z.string().min(1),
  })
  .strict();
export type SpeakingVoice = z.infer<typeof SpeakingVoiceSchema>;

/** The line every candidate says. */
export function speakingTestLine(name: string): string {
  return `Hi, I'm ${name}. Honestly, I'm a bit nervous, but I'm really excited to be here.`;
}

/** The median sung pitch (Hz) of a singer's voice reference, from SoulX-Singer's description of it (voice.json: the
 *  f0 of every part, 0 where it is silent). Throws, naming the file, when it holds no pitch. */
export function medianSungHz(metaPath: string): number {
  const parts = z.array(z.object({ f0: z.string() }).passthrough()).min(1).parse(JSON.parse(readFileSync(metaPath, 'utf8')));
  const f0 = parts.flatMap((p) => p.f0.split(/\s+/u).map(Number)).filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (f0.length === 0) throw new Error(`speaking voice: ${metaPath} holds no sung pitch`);
  const mid = Math.floor(f0.length / 2);
  return f0.length % 2 ? f0[mid]! : (f0[mid - 1]! + f0[mid]!) / 2;
}

/** What the language model is told about a singer. */
export interface VoiceFacts {
  readonly name: string;
  /** The uploader's words about the voice. */
  readonly description: string;
  readonly medianHz: number;
}

/** One sentence describing the singer's speaking voice for the speech synthesiser, written by the language model. */
export async function describeVoice(chat: ChatModel, facts: VoiceFacts): Promise<string> {
  const hz = Math.round(facts.medianHz / 10) * 10;
  const system =
    'You write one-sentence descriptions of speaking voices for a speech synthesiser. The synthesiser makes a voice ' +
    'from the sentence alone, so the sentence must say whether it is a man or a woman, roughly how old, how high or ' +
    'low the voice sits, its texture (for example bright, warm, husky, breathy, smooth) and the manner of speaking. ' +
    'The voice must sound natural and conversational. Do not mention singing. Do not give an accent unless the notes ' +
    'below name one. Never name a real person. Answer with JSON only: {"description": "<the sentence>"}.';
  const user =
    `A singer called "${facts.name}" needs a speaking voice that fits their singing voice.\n` +
    `What the person who added the singer wrote about the voice: "${facts.description}".\n` +
    `The middle of their singing voice is about ${hz} Hz. As a guide: a singing voice in the middle below about 165 Hz ` +
    'is usually a man, above it usually a woman; people speak lower than they sing, so place the speaking voice ' +
    'somewhat lower than the singing, and call a voice high only when the singing sits very high.\n' +
    'Write the description.';
  const answer = await chat.complete(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { thinking: false },
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer);
  } catch {
    throw new Error(`speaking voice: the language model's answer is not JSON: ${answer.slice(0, 200)}`);
  }
  const r = z.object({ description: z.string().trim().min(10).max(400) }).safeParse(parsed);
  if (!r.success) throw new Error(`speaking voice: the language model gave no usable description: ${answer.slice(0, 200)}`);
  return r.data.description;
}

/** The speaking voices of the owners' singers, kept in the singers' data folder. */
export class SpeakingVoices {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  dir(ownerId: string, singerId: string, builtIn: boolean): string {
    if (!/^[a-z0-9_-]+$/u.test(singerId)) throw new Error(`speaking voice: "${singerId}" is not a singer id`);
    const owner = join(this.root, ownerFolder(ownerId));
    return builtIn ? join(owner, 'builtin-speaking', singerId) : join(owner, singerId, 'speaking');
  }

  get(ownerId: string, singerId: string, builtIn: boolean): SpeakingVoice | undefined {
    const file = join(this.dir(ownerId, singerId, builtIn), 'speaking.json');
    if (!existsSync(file)) return undefined;
    return SpeakingVoiceSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  }

  samplePath(ownerId: string, singerId: string, builtIn: boolean): string {
    return join(this.dir(ownerId, singerId, builtIn), 'speaking.wav');
  }

  /** Replaces the singer's speaking voice: the candidates' files (seed -> file) and the chosen one, all at once; the
   *  earlier voice stays until the new one is complete. */
  save(ownerId: string, singerId: string, builtIn: boolean, voice: SpeakingVoice, candidates: ReadonlyMap<number, string>): void {
    SpeakingVoiceSchema.parse(voice);
    if (!candidates.has(voice.seed)) throw new Error(`speaking voice: no candidate file for the chosen seed ${voice.seed}`);
    const dir = this.dir(ownerId, singerId, builtIn);
    const part = `${dir}.part-${randomUUID()}`;
    rmSync(part, { recursive: true, force: true });
    mkdirSync(join(part, 'candidates'), { recursive: true });
    for (const c of voice.candidates) {
      const src = candidates.get(c.seed);
      if (!src) throw new Error(`speaking voice: no candidate file for seed ${c.seed}`);
      copyFileSync(src, join(part, 'candidates', `candidate-${c.seed}.wav`));
    }
    copyFileSync(candidates.get(voice.seed)!, join(part, 'speaking.wav'));
    writeFileSync(join(part, 'speaking.json'), `${JSON.stringify(voice, null, 1)}\n`);
    mkdirSync(dirname(dir), { recursive: true });
    const old = `${dir}.old-${randomUUID()}`;
    if (existsSync(dir)) renameSync(dir, old);
    renameSync(part, dir);
    rmSync(old, { recursive: true, force: true });
  }

  /** Makes another of the singer's candidates its speaking voice. Throws for a seed that is not a candidate. */
  choose(ownerId: string, singerId: string, builtIn: boolean, seed: number): SpeakingVoice {
    const voice = this.get(ownerId, singerId, builtIn);
    if (!voice) throw new Error('speaking voice: the singer has no speaking voice yet');
    if (!voice.candidates.some((c) => c.seed === seed)) throw new Error(`speaking voice: ${seed} is not one of the singer's candidates`);
    const dir = this.dir(ownerId, singerId, builtIn);
    const next: SpeakingVoice = { ...voice, seed };
    copyFileSync(join(dir, 'candidates', `candidate-${seed}.wav`), join(dir, `speaking.wav.part-${process.pid}`));
    renameSync(join(dir, `speaking.wav.part-${process.pid}`), join(dir, 'speaking.wav'));
    writeFileSync(join(dir, `speaking.json.part-${process.pid}`), `${JSON.stringify(next, null, 1)}\n`);
    renameSync(join(dir, `speaking.json.part-${process.pid}`), join(dir, 'speaking.json'));
    return next;
  }
}
