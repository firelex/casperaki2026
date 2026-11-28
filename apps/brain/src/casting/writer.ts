// The casting writer (docs/superpowers/specs/2026-11-28-video-modes-casting-design.md, "Writing the talk"): the
// spoken script of a casting video in three scenes. Each scene is planned once (its beats and who speaks in which
// order), then written one line at a time: the speaker's line in character, seeing the plan, their profile and
// everything said so far. Every line carries a delivery note for the voice and a gesture for the body.
// Nothing is repaired: an answer that is not what was asked for fails the script, quoting the answer.

import { z } from 'zod';

import type { ChatMessage, ChatModel } from '../llm/chatModel.js';
import { CancelledError } from '../sing/singTask.js';
import { castNames, JUDGES, JURY_DYNAMIC, JURY_RULES, NARRATOR_PROFILE, type JudgeId, type Outcome, type Vote } from './cast.js';
import type { CastingFacts } from './facts.js';

export const GESTURES = ['nod', 'shakeHead', 'laugh', 'leanBack', 'leanIn', 'point', 'clap', 'handsUp', 'shrug', 'none'] as const;
export type Gesture = (typeof GESTURES)[number];
export type Speaker = 'narrator' | JudgeId | 'singer';
export interface ScriptLine {
  readonly speaker: Speaker;
  readonly text: string;
  readonly delivery: string;
  readonly gesture: Gesture;
}
export type SceneId = 'backstage' | 'banter' | 'verdicts';
export const SCENES: readonly SceneId[] = ['backstage', 'banter', 'verdicts'];
export interface CastingScript {
  readonly outcome: Outcome;
  readonly votes: Readonly<Record<JudgeId, Vote>>;
  readonly backstage: readonly ScriptLine[];
  readonly banter: readonly ScriptLine[];
  readonly verdicts: readonly ScriptLine[];
}

/** Words a scene may have: its length in the spec at about 2.6 spoken words a second, with room either way. */
const SCENE_WORDS: Readonly<Record<SceneId, readonly [number, number]>> = { backstage: [60, 170], banter: [12, 90], verdicts: [45, 170] };
/** The words a scene is planned for. */
const SCENE_TARGET: Readonly<Record<SceneId, number>> = { backstage: 100, banter: 45, verdicts: 95 };
const TURNS: Readonly<Record<SceneId, readonly [number, number]>> = { backstage: [4, 7], banter: [2, 6], verdicts: [6, 11] };

const OUTCOME_WORDS: Readonly<Record<Outcome, string>> = {
  fourYes: 'The singer goes through with four yeses.',
  threeOne: 'The singer goes through, three votes to one.',
  notThisTime: 'The singer does not go through: every judge says no.',
};

const PlanSchema = z.object({
  beats: z.array(z.string().min(1)).min(1),
  turns: z.array(z.object({ speaker: z.string().min(1), intent: z.string().min(1), words: z.number().int().min(2).max(70) })).min(1),
});
const TurnSchema = z.object({ text: z.string(), delivery: z.string(), gesture: z.string().optional() });

function parse<T>(schema: z.ZodType<T>, answer: string, what: string): T {
  let json: unknown;
  try {
    json = JSON.parse(answer);
  } catch {
    throw new Error(`casting writer: ${what}: the answer is not JSON: ${answer.slice(0, 200)}`);
  }
  const r = schema.safeParse(json);
  if (!r.success) throw new Error(`casting writer: ${what}: the answer is not the JSON asked for (${r.error.issues[0]!.path.join('.')}: ${r.error.issues[0]!.message}): ${answer.slice(0, 200)}`);
  return r.data;
}

/** The people in the script by the names the model sees. */
function names(facts: CastingFacts): Record<Speaker, string> {
  return { narrator: 'Narrator', ice: 'Ice', nicky: 'Nicky', love: 'Love', bob: 'Bob', singer: facts.singerName };
}

function singerProfile(facts: CastingFacts): string {
  return (
    `The contestant: a singer called ${facts.singerName} (always call them ${facts.singerName}). ` +
    (facts.singerDescription ? `What the person who added this singer wrote about the voice: "${facts.singerDescription}". ` : '') +
    'Nervous but hopeful, polite, a little funny when relaxed; answers questions briefly and in their own words.'
  );
}

function songText(facts: CastingFacts): string {
  const quotes = facts.quotes.length > 0 ? `Some of its words:\n${facts.quotes.map((q) => `  "${q}"`).join('\n')}` : 'The song has no words yet: do not quote or invent any lyrics.';
  return (
    `The song: "${facts.title}"${facts.genre ? `, ${facts.genre}` : ''}, ${facts.tempoWord}. ` +
    `Its sections in order: ${facts.sections.join(', ')}. It was written for the contestant to sing.\n${quotes}`
  );
}

function sceneText(scene: SceneId, facts: CastingFacts, outcome: Outcome, votes: Readonly<Record<JudgeId, Vote>>): string {
  const n = names(facts);
  if (scene === 'backstage') {
    return (
      'The scene: backstage, before the audition. Only the Narrator speaks, over pictures of the contestant getting ready. ' +
      `Say the name ${n.singer} in the first turn. Tell ${n.singer}'s back story: who they are, who created them, where they come from, what this audition means to them, ` +
      'and a word about the song. ' +
      (facts.backstory
        ? `The back story, from the person who made this singer: "${facts.backstory}". Use it; add colour, but do not contradict it. `
        : `No back story was given: make up a short, believable one that fits ${n.singer}'s name and voice, and keep it light. `) +
      'Do not keep saying that they are about to walk on stage (the audience knows): at most the last turn leads into it. ' +
      'Do not reveal how the audition ends.'
    );
  }
  if (scene === 'banter') {
    return (
      `The scene: ${n.singer} has just walked on stage to the judges' desk. It is short: one judge greets ${n.singer} and has a ` +
      `quick exchange with them (a question and ${n.singer}'s answer); another judge may add one quick aside, but the others stay ` +
      'quiet. They have not heard the song yet. The scene ends with a judge inviting the contestant to begin.'
    );
  }
  const list = JUDGES.map((j) => `${j.name}: ${votes[j.id]}`).join(', ');
  return (
    `The scene: ${n.singer} has just sung the song up to the end of its first chorus. ${OUTCOME_WORDS[outcome]} The votes: ${list}. ` +
    'It has two parts. First, one judge leads and gives the real critique, talking a little longer (two to four sentences) about ' +
    'specific things in the song; one or two others may react briefly, but not every judge needs to speak here. Then one judge ' +
    'starts the yes-or-no round, and it is quick: each judge says their vote in a few words, in their own manner. ' +
    `Every turn of a judge fits that judge's vote: a judge voting no is unconvinced throughout (kind or harsh, as is their way), ` +
    `never praising the song first and voting no later. ${n.singer} may react once, before the end. The very last turn of the ` +
    "scene is Ice's, and it gives his vote: nobody speaks after him."
  );
}

function speakersOf(scene: SceneId): Speaker[] {
  return scene === 'backstage' ? ['narrator'] : [...JUDGES.map((j) => j.id), 'singer'];
}

function castText(scene: SceneId, facts: CastingFacts): string {
  if (scene === 'backstage') return `The Narrator: ${NARRATOR_PROFILE}\n\n${singerProfile(facts)}`;
  return `${JUDGES.map((j) => `${j.name}: ${j.profile}`).join('\n\n')}\n\nHow the judges play together: ${JURY_DYNAMIC}\n\n${JURY_RULES}\n\n${singerProfile(facts)}`;
}

const SHOW =
  'This is a short animated video in the style of a television talent show (like a music audition programme): a ' +
  'contestant sings their own new song to a panel of four judges. The talk must sound natural and spontaneous, like ' +
  'real people on television, never stilted or written. All characters are fictional; never mention or imitate real people.';

function transcript(lines: readonly { speaker: Speaker; text: string }[], n: Record<Speaker, string>): string {
  return lines.length ? lines.map((l) => `${n[l.speaker]}: ${l.text}`).join('\n') : '(nothing has been said yet)';
}

/** Writes the whole script. `onLine` hears each line as it is written. Throws CancelledError when `signal` aborts. */
export async function writeScript(
  chat: ChatModel,
  facts: CastingFacts,
  outcome: Outcome,
  votes: Readonly<Record<JudgeId, Vote>>,
  signal: AbortSignal,
  onLine?: (scene: SceneId, line: ScriptLine) => void,
): Promise<CastingScript> {
  if (castNames().includes(facts.singerName.trim().toLowerCase())) {
    throw new Error(`casting writer: the singer "${facts.singerName}" has the same name as someone in the cast: rename the singer`);
  }
  const n = names(facts);
  const byName = new Map(Object.entries(n).map(([id, name]) => [name.toLowerCase(), id as Speaker]));
  const said: { speaker: Speaker; text: string }[] = [];
  const out: Record<SceneId, ScriptLine[]> = { backstage: [], banter: [], verdicts: [] };
  const ask = async (messages: ChatMessage[]) => {
    if (signal.aborted) throw new CancelledError();
    const answer = await chat.complete(messages, { thinking: false });
    if (signal.aborted) throw new CancelledError();
    return answer;
  };

  for (const scene of SCENES) {
    const allowed = speakersOf(scene).map((s) => n[s]);
    const [minTurns, maxTurns] = TURNS[scene];
    const plan = parse(
      PlanSchema,
      await ask([
        {
          role: 'system',
          content:
            `You plan one scene of a script. ${SHOW}\n\n${sceneText(scene, facts, outcome, votes)}\n\n` +
            `Plan the scene's beats (what happens, in order) and its turns: who speaks, in order, and what each turn is for ` +
            `(its intent, in a few words) and roughly how many words it has. Use between ${minTurns} and ${maxTurns} turns; people ` +
            `may react to or interrupt each other. The whole scene is about ${SCENE_TARGET[scene]} spoken words in all, so keep it tight. ` +
            `Only these people speak in this scene: ${allowed.join(', ')}. ` +
            (scene === 'verdicts'
              ? `Every judge speaks at least once; each judge's last turn is the one where they give their vote, and the last turn of the scene is Ice's. ${n.singer} has at most ONE turn in this scene. `
              : '') +
            `Answer with JSON only: {"beats": ["..."], "turns": [{"speaker": "<one of: ${allowed.join(', ')}>", "intent": "...", "words": <a whole number>}]}.`,
        },
        { role: 'user', content: `${castText(scene, facts)}\n\n${songText(facts)}\n\nWhat has been said so far in the video:\n${transcript(said, n)}\n\nPlan the scene.` },
      ]),
      `the ${scene} plan`,
    );
    if (plan.turns.length < minTurns || plan.turns.length > maxTurns) {
      throw new Error(`casting writer: the ${scene} plan has ${plan.turns.length} turns; it must have ${minTurns} to ${maxTurns}`);
    }
    const turns = plan.turns.map((t, i) => {
      const speaker = byName.get(t.speaker.trim().toLowerCase());
      if (!speaker || !speakersOf(scene).includes(speaker)) throw new Error(`casting writer: the ${scene} plan gives turn ${i + 1} to "${t.speaker}", who is not in the scene (${allowed.join(', ')})`);
      return { speaker, intent: t.intent, words: t.words, vote: false };
    });
    // In the verdicts each judge votes in their last turn.
    if (scene === 'verdicts') for (const j of JUDGES) {
      const last = turns.map((t) => t.speaker).lastIndexOf(j.id);
      if (last >= 0) turns[last]!.vote = true;
    }
    if (scene === 'verdicts') {
      for (const j of JUDGES) {
        if (!turns.some((t) => t.speaker === j.id)) throw new Error(`casting writer: the verdicts plan gives ${j.name} no turn to vote in`);
      }
      const last = turns.at(-1)!;
      if (last.speaker !== 'ice') throw new Error('casting writer: in the verdicts plan Ice must speak last, giving his vote');
      const singerTurns = turns.filter((t) => t.speaker === 'singer').length;
      if (singerTurns > 1) throw new Error(`casting writer: in the verdicts plan ${n.singer} speaks ${singerTurns} times; once at most`);
    }

    for (const [i, turn] of turns.entries()) {
      const who = n[turn.speaker];
      // A judge voting no is unconvinced in every verdicts turn: the plan's purpose for the turn (often written from the
      // judge's usual manner, e.g. Bob leaping up) gives way to the vote.
      const against = scene === 'verdicts' && turn.speaker !== 'narrator' && turn.speaker !== 'singer' && votes[turn.speaker] === 'no';
      const intent = against ? `react honestly to a song ${who} did not like${turn.vote ? ', and give the no' : ''}` : turn.intent;
      // The plan's length for the line (a guide; the scene's total is checked below); votes are quick.
      const budget = turn.vote ? Math.min(turn.words, 12) : turn.words;
      // The narrator is heard, never seen: no gesture.
      const seen = turn.speaker !== 'narrator';
      const profile = turn.speaker === 'narrator' ? NARRATOR_PROFILE : turn.speaker === 'singer' ? singerProfile(facts) : JUDGES.find((j) => j.id === turn.speaker)!.profile;
      const answer = parse(
        TurnSchema,
        await ask([
          {
            role: 'system',
            content:
              `You write one line of a script, spoken by ${who}. ${SHOW}\n\n` +
              (scene === 'verdicts' && turn.speaker !== 'narrator' && turn.speaker !== 'singer'
                ? votes[turn.speaker] === 'yes'
                  ? `Most important: in this scene ${who} LIKED the performance and votes yes.\n\n`
                  : `Most important: in this scene ${who} did NOT like the performance and votes no. Whatever ${who} is usually like, ${who} is not enthusiastic about this song: no praise that sounds like a yes.\n\n`
                : '') +
              `Who ${who} is: ${profile}\n\n` +
              (turn.speaker !== 'narrator' && turn.speaker !== 'singer' ? `The sample lines in that description show the voice; never copy them.\n\n` : '') +
              `${sceneText(scene, facts, outcome, votes)}\n\nThe scene's beats: ${plan.beats.join('; ')}.\n\n` +
              (scene === 'verdicts' && turn.speaker !== 'narrator' && turn.speaker !== 'singer'
                ? `${who}'s vote is ${votes[turn.speaker].toUpperCase()}: everything ${who} says in this scene must fit that vote; if the turn's purpose below does not fit it, follow the vote. ` +
                  (turn.vote ? `This is your vote turn: say plainly, with the word "${votes[turn.speaker]}", that ${who}'s vote is ${votes[turn.speaker]}. ` : '')
                : '') +
              `Write ${who}'s next line: what this turn is for is "${intent}". Keep it to about ${budget} words, never more than ` +
              `${budget * 2}; one or two sentences, as people really talk; react to what was just said. Never read out numbers such ` +
              'as the tempo. Also give a short delivery note for the voice actor (for example "dry, unimpressed" or "laughing")' +
              (seen
                ? ` and one gesture from this list: ${GESTURES.join(', ')}. Answer with JSON only: {"text": "<the spoken words only>", "delivery": "...", "gesture": "..."}.`
                : '. Answer with JSON only: {"text": "<the spoken words only>", "delivery": "..."}.'),
          },
          { role: 'user', content: `${songText(facts)}\n\nWhat has been said so far:\n${transcript(said, n)}\n\nWrite ${who}'s line.` },
        ]),
        `${scene}, turn ${i + 1} (${who})`,
      );
      const text = answer.text.trim();
      if (!text) throw new Error(`casting writer: ${scene}, turn ${i + 1} (${who}): the line is empty`);
      if (seen && !(GESTURES as readonly string[]).includes(answer.gesture ?? '')) throw new Error(`casting writer: ${scene}, turn ${i + 1} (${who}): "${answer.gesture}" is not one of the gestures (${GESTURES.join(', ')})`);
      if (turn.vote && turn.speaker !== 'narrator' && turn.speaker !== 'singer') {
        const vote = votes[turn.speaker];
        if (!new RegExp(`\\b${vote}\\b`, 'iu').test(text)) throw new Error(`casting writer: ${scene}, turn ${i + 1} (${who}): the vote turn does not say "${vote}": ${text}`);
      }
      const line: ScriptLine = { speaker: turn.speaker, text, delivery: answer.delivery.trim(), gesture: seen ? (answer.gesture as Gesture) : 'none' };
      out[scene].push(line);
      said.push(line);
      onLine?.(scene, line);
    }
    const count = out[scene].reduce((a, l) => a + l.text.split(/\s+/u).filter(Boolean).length, 0);
    const [lo, hi] = SCENE_WORDS[scene];
    if (count < lo || count > hi) throw new Error(`casting writer: the ${scene} scene is ${count} words; it must be ${lo} to ${hi} for its time`);
  }
  return { outcome, votes, ...out };
}
