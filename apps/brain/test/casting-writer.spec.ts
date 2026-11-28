// The casting writer (docs/superpowers/plans/2026-11-28-casting-3-writer.md): the cast, the song facts, the scene
// plans and one model call per line, against a scripted fake language model.

import { orchestrate } from '@casperaki/arrangement';
import { describe, expect, it } from 'vitest';

import { JUDGES, verdictVotes } from '../src/casting/cast.js';
import { castingFacts, pickQuotes } from '../src/casting/facts.js';
import { songTiming } from '../src/video/videoInput.js';

const song = orchestrate({ genre: 'brightPop', key: 'C', bpm: 120, seed: 'casting-1' });

describe('the cast', () => {
  it('is the four judges with their approved voices, in plain-English profiles naming no real person', () => {
    expect(JUDGES.map((j) => j.id)).toEqual(['ice', 'nicky', 'love', 'bob']);
    expect(JUDGES.map((j) => j.voice.seed)).toEqual([7, 7, 7, 21]);
    expect(JUDGES.find((j) => j.id === 'bob')!.voice.description).toMatch(/Irish man/);
    // Each judge's reference says the words of the take the owner approved.
    expect(JUDGES.find((j) => j.id === 'ice')!.voice.referenceText).toMatch(/^Right\. Well\. That was certainly a choice/);
    expect(JUDGES.find((j) => j.id === 'love')!.voice.referenceText).toMatch(/nineteen ninety eight/);
    expect(new Set(JUDGES.map((j) => j.voice.referenceText)).size).toBe(4);
    for (const j of JUDGES) {
      expect(j.profile.length).toBeGreaterThan(300);
      expect(j.profile).not.toMatch(/Cowell|Walsh|Minaj|Minogue/);
    }
  });
  it('votes as the outcome says; three to one picks one "no", the same for the same song', () => {
    expect(Object.values(verdictVotes('fourYes', 's1'))).toEqual(['yes', 'yes', 'yes', 'yes']);
    expect(Object.values(verdictVotes('notThisTime', 's1'))).toEqual(['no', 'no', 'no', 'no']);
    const v = verdictVotes('threeOne', 's1');
    expect(Object.values(v).filter((x) => x === 'no')).toHaveLength(1);
    expect(verdictVotes('threeOne', 's1')).toEqual(v);
    const noes = new Set(Array.from({ length: 40 }, (_, i) => Object.entries(verdictVotes('threeOne', `song-${i}`)).find(([, x]) => x === 'no')![0]));
    expect(noes.size).toBeGreaterThan(1);
  });
});

describe('the song facts', () => {
  it('quotes the first chorus and describes the tempo', () => {
    const f = castingFacts(song, 'Electric Daydream', { name: 'Kesha', description: 'bright pop voice' }, 'Mia', null);
    expect(f.title).toBe('Electric Daydream');
    expect(f.bpm).toBe(120);
    expect(f.tempoWord).toBe('fast');
    const chorus = songTiming(song).sections.find((s) => /^chorus\b/iu.test(s.name))!;
    expect(f.sections).toContain(chorus.name);
    // Generated songs carry no words until lyrics are written (6b6ab03): the quotes are picked from given lines.
    const sections = [{ name: 'Verse 1', startSeconds: 0, endSeconds: 10 }, { name: 'Pre-chorus', startSeconds: 10, endSeconds: 20 }, { name: 'Chorus 1', startSeconds: 20, endSeconds: 40 }];
    const lines = ['v1', 'p1', 'c1', 'c2', 'c3', 'c4', 'c5'].map((text, i) => ({ text, startSeconds: [2, 12, 21, 25, 29, 33, 37][i]! }));
    expect(pickQuotes(lines, sections)).toEqual(['c1', 'c2', 'c3', 'c4']);
    expect(pickQuotes(lines.slice(0, 2), sections)).toEqual(['v1', 'p1']);
    expect(f).toMatchObject({ singerName: 'Kesha', singerDescription: 'bright pop voice', avatarName: 'Mia' });
  });
  it('refuses a song without a title', () => {
    expect(() => castingFacts(song, ' ', { name: 'Kesha', description: null }, 'Mia', null)).toThrow(/no title/);
  });
  it('has no quotes for a song without words', () => {
    const silent = { ...song, arrangement: Object.fromEntries(Object.entries(song.arrangement).map(([k, v]) => [k, { ...v, overrides: {} }])) } as typeof song;
    expect(castingFacts(silent, 'Electric Daydream', { name: 'Kesha', description: null }, 'Mia', null).quotes).toEqual([]);
  });
});

// ---- the writer, against a scripted fake model
import type { ChatMessage, ChatModel } from '../src/llm/chatModel.js';
import { writeScript, type CastingScript } from '../src/casting/writer.js';

type Plan = { beats: string[]; turns: { speaker: string; intent: string; words?: number }[] };
const words = (n: number) => Array.from({ length: n }, (_, i) => (i === 0 ? 'Well' : 'word')).join(' ') + '.';
const PLANS: Record<string, Plan> = {
  backstage: { beats: ['who she is', 'the song'], turns: Array.from({ length: 5 }, (_, i) => ({ speaker: 'Narrator', intent: `part ${i}` })) },
  banter: {
    beats: ['greeting', 'question', 'teasing'],
    turns: [
      { speaker: 'Bob', intent: 'greets warmly' },
      { speaker: 'Kesha', intent: 'answers' },
      { speaker: 'Bob', intent: 'asks about the song' },
      { speaker: 'Kesha', intent: 'answers' },
      { speaker: 'Bob', intent: 'tells her to begin' },
    ],
  },
  verdicts: {
    beats: ['critique', 'votes', 'thanks'],
    turns: [
      { speaker: 'Love', intent: 'the critique' },
      { speaker: 'Nicky', intent: 'reacts' },
      { speaker: 'Ice', intent: 'starts the vote round' },
      { speaker: 'Bob', intent: 'votes' },
      { speaker: 'Nicky', intent: 'votes' },
      { speaker: 'Love', intent: 'votes' },
      { speaker: 'Ice', intent: 'last vote' },
      { speaker: 'Kesha', intent: 'thanks them' },
    ],
  },
};
const sceneOf = (system: string) => (system.includes('backstage') ? 'backstage' : system.includes('yes-or-no round') ? 'verdicts' : 'banter');

function fakeModel(over: { plan?: Partial<Record<string, Plan>>; turn?: (n: number) => unknown; wordsPerTurn?: number } = {}) {
  const calls: ChatMessage[][] = [];
  let turns = 0;
  const chat: ChatModel = {
    complete: async (messages) => {
      calls.push([...messages]);
      const system = messages[0]!.content;
      if (system.startsWith('You plan')) {
        const scene = sceneOf(system);
        const plan = over.plan?.[scene] ?? PLANS[scene]!;
        return JSON.stringify({ ...plan, turns: plan.turns.map((t) => ({ words: 12, ...t })) });
      }
      turns += 1;
      const voteTurn = system.includes('This is your vote turn');
      return JSON.stringify(over.turn?.(turns) ?? { text: words(over.wordsPerTurn ?? 14) + (voteTurn ? ' Yes.' : ''), delivery: 'warm', gesture: 'nod' });
    },
  };
  return { chat, calls };
}
const facts = { ...castingFacts(song, 'Electric Daydream', { name: 'Kesha', description: 'a bright, clear pop voice' }, 'Mia', null), quotes: ['Hands up, hands up, under the lights'] };
const yes = { ice: 'yes', nicky: 'yes', love: 'yes', bob: 'yes' } as const;
const run = (chat: ChatModel, signal = new AbortController().signal, f = facts) => writeScript(chat, f, 'fourYes', yes, signal);

describe('the writer', () => {
  it('writes the three scenes, line by line, the narrator alone backstage and Ice last in the verdicts', async () => {
    const { chat, calls } = fakeModel();
    const script: CastingScript = await run(chat);
    expect(script.backstage.map((l) => l.speaker)).toEqual(Array(5).fill('narrator'));
    expect(script.banter.map((l) => l.speaker)).toEqual(['bob', 'singer', 'bob', 'singer', 'bob']);
    expect(script.verdicts.at(-1)!.speaker).toBe('singer');
    expect(script.verdicts.at(-2)!.speaker).toBe('ice');
    expect(script.verdicts[0]).toMatchObject({ delivery: 'warm', gesture: 'nod' });
    // The narrator is never seen: no gesture.
    expect(script.backstage.every((l) => l.gesture === 'none')).toBe(true);
    expect(calls).toHaveLength(3 + 5 + 5 + 8);
    // Each line is written seeing the conversation so far.
    const lastTurn = calls.at(-1)!.map((m) => m.content).join('\n');
    expect(lastTurn).toContain('Bob:');
  });
  it('grounds the talk in the song, the singer and the votes, naming no real person', async () => {
    const { chat, calls } = fakeModel();
    await run(chat);
    const all = calls.flat().map((m) => m.content).join('\n');
    expect(all).toContain('Kesha');
    expect(all).toContain('a bright, clear pop voice');
    // The performer goes by the singer's name only (the avatar's name confused the narrator).
    expect(all).not.toContain('Mia');
    expect(all).toContain(facts.quotes[0]!);
    expect(all).toMatch(/Ice: yes/);
    expect(all).not.toMatch(/beats a minute/);
    expect(all).toMatch(/Bob's vote is YES: everything Bob says in this scene must fit that vote/);
    expect(all).not.toMatch(/Cowell|Walsh|Minaj|Minogue/);
  });
  it('tells the writer when the song has no words yet, and never quotes', async () => {
    const { chat, calls } = fakeModel();
    await run(chat, undefined, { ...facts, quotes: [] });
    const all = calls.flat().map((m) => m.content).join('\n');
    expect(all).toMatch(/has no words yet/);
  });
  it('leaves out the voice description when none was written', async () => {
    const { chat, calls } = fakeModel();
    await run(chat, undefined, { ...facts, singerDescription: null });
    expect(calls.flat().map((m) => m.content).join('\n')).not.toMatch(/wrote about the voice/);
  });
  it('refuses a plan with someone who is not in the scene', async () => {
    const { chat } = fakeModel({ plan: { backstage: { beats: ['x'], turns: [{ speaker: 'Ice', intent: 'x' }, ...PLANS.backstage!.turns] } } });
    await expect(run(chat)).rejects.toThrow(/backstage.*"Ice"/);
  });
  it('refuses verdicts where a judge has no turn, or Ice does not speak last', async () => {
    const noLove = { ...PLANS.verdicts!, turns: PLANS.verdicts!.turns.map((t) => (t.speaker === 'Love' ? { ...t, speaker: 'Nicky' } : t)) };
    await expect(run(fakeModel({ plan: { verdicts: noLove } }).chat)).rejects.toThrow(/Love/);
    const t = PLANS.verdicts!.turns;
    const loveVotesLast = { ...PLANS.verdicts!, turns: [...t.slice(0, 5), t[6]!, t[5]!, t[7]!] };
    await expect(run(fakeModel({ plan: { verdicts: loveVotesLast } }).chat)).rejects.toThrow(/Ice must give the last vote/);
    const iceDoesNotStart = { ...PLANS.verdicts!, turns: [t[0]!, t[1]!, t[3]!, t[2]!, t[4]!, t[5]!, t[6]!, t[7]!] };
    await expect(run(fakeModel({ plan: { verdicts: iceDoesNotStart } }).chat)).rejects.toThrow(/Ice must start the vote round/);
    const noThanks = { ...PLANS.verdicts!, turns: t.slice(0, 7) };
    await expect(run(fakeModel({ plan: { verdicts: noThanks } }).chat)).rejects.toThrow(/must speak once, last/);
    const twoJudges = { ...PLANS.banter!, turns: [...PLANS.banter!.turns.slice(0, 4), { speaker: 'Ice', intent: 'go' }] };
    await expect(run(fakeModel({ plan: { banter: twoJudges } }).chat)).rejects.toThrow(/exactly one judge speaks/);
  });
  it('needs a vote turn for every judge, Ice\'s last, each vote said plainly; a judge voting no is unconvinced throughout', async () => {
    const { chat, calls } = fakeModel();
    await writeScript(chat, facts, 'threeOne', { ...yes, bob: 'no' }, new AbortController().signal).catch(() => undefined);
    const bobVerdict = calls.find((c) => c[0]!.content.includes('spoken by Bob') && c[0]!.content.includes('did NOT like'));
    expect(bobVerdict?.[0]!.content).toMatch(/what this turn is for is "react honestly to a song Bob did not like, and give the no"/);
    // Bob speaks twice: only his last turn is his vote turn.
    const bobTwice = { ...PLANS.verdicts!, turns: [{ speaker: 'Bob', intent: 'first thoughts' }, ...PLANS.verdicts!.turns] };
    const { chat: c2, calls: k2 } = fakeModel({ plan: { verdicts: bobTwice } });
    await run(c2);
    expect(k2.filter((c) => c[0]!.content.includes('spoken by Bob') && c[0]!.content.includes('This is your vote turn'))).toHaveLength(1);
    // Bob's vote turn (the fourth verdicts turn, after 5 backstage and 5 banter lines) says no although his vote is yes.
    await expect(run(fakeModel({ turn: (n) => (n === 14 ? { text: 'Sorry, it is a no from me.', delivery: 'x', gesture: 'nod' } : undefined) }).chat)).rejects.toThrow(/verdicts, turn 4 \(Bob\).*yes/);
  });
  it('lets the singer react only once in the verdicts, and has the narrator name them first', async () => {
    const twice = { ...PLANS.verdicts!, turns: [{ speaker: 'Kesha', intent: 'gasps' }, ...PLANS.verdicts!.turns] };
    await expect(run(fakeModel({ plan: { verdicts: twice } }).chat)).rejects.toThrow(/Kesha must speak once, last/);
    const { chat, calls } = fakeModel();
    await run(chat);
    expect(calls[0]![0]!.content).toContain('Say the name Kesha in the first turn');
  });
  it('refuses an empty line or an unknown gesture, naming the turn', async () => {
    await expect(run(fakeModel({ turn: (n) => (n === 7 ? { text: ' ', delivery: 'x', gesture: 'nod' } : undefined) }).chat)).rejects.toThrow(/banter, turn 2/);
    await expect(run(fakeModel({ turn: (n) => (n === 6 ? { text: 'Hi.', delivery: 'x', gesture: 'moonwalk' } : undefined) }).chat)).rejects.toThrow(/banter, turn 1/);
  });
  it('refuses a scene far longer or shorter than its time, naming its length', async () => {
    await expect(run(fakeModel({ wordsPerTurn: 80 }).chat)).rejects.toThrow(/backstage.*400 words/);
  });
  it('tells the singer\'s back story when one is given, and makes up a light one when not', async () => {
    const a = fakeModel();
    await run(a.chat, undefined, { ...facts, backstory: 'A 19-year-old virtual singer conceived by Maddie, who lives in London.' });
    const told = a.calls.flat().map((m) => m.content).join('\n');
    expect(told).toContain('conceived by Maddie, who lives in London');
    expect(told).toMatch(/Do not keep saying that they are about to walk on stage/);
    const b = fakeModel();
    await run(b.chat);
    expect(b.calls.flat().map((m) => m.content).join('\n')).toMatch(/No back story was given: make up a short, believable one/);
  });
  it('keeps the meeting short with one judge, and the verdicts a critique then a quick yes-or-no round', async () => {
    const { chat, calls } = fakeModel();
    await run(chat);
    const all = calls.flat().map((m) => m.content).join('\n');
    expect(all).toMatch(/only ONE judge speaks/);
    expect(all).toMatch(/one judge leads and gives the real critique/);
    expect(all).toMatch(/Ice, the head judge, starts the yes-or-no round/);
    expect(all).toMatch(/thanks the judges in a few words: that is the last turn/);
    // A vote line is kept to a few words whatever the plan says.
    const vote = calls.find((c) => c[0]!.content.includes('This is your vote turn'))!;
    expect(vote[0]!.content).toMatch(/Keep it to about 12 words/);
  });
  it('stops at once when cancelled', async () => {
    const ac = new AbortController();
    const { chat, calls } = fakeModel({ turn: (n) => (n === 2 ? (ac.abort(), undefined) : undefined) });
    await expect(run(chat, ac.signal)).rejects.toThrow(/cancel/i);
    expect(calls.length).toBe(3);
  });
});

describe('review fixes', () => {
  it('counts only sections named chorus as a chorus, not a pre-chorus', async () => {
    const { isChorus } = await import('../src/casting/facts.js');
    expect(isChorus('Chorus')).toBe(true);
    expect(isChorus('Chorus 2')).toBe(true);
    expect(isChorus('Pre-chorus')).toBe(false);
    expect(isChorus('Post-chorus')).toBe(false);
    expect(isChorus('Verse 1')).toBe(false);
  });
  it('refuses a singer named like someone in the cast', async () => {
    const { chat } = fakeModel();
    await expect(run(chat, undefined, { ...facts, singerName: 'nicky' })).rejects.toThrow(/singer.*"nicky".*same name/i);
    await expect(run(chat, undefined, { ...facts, singerName: 'Narrator' })).rejects.toThrow(/same name/i);
  });
  it('refuses a plan with too many or too few turns before writing any line', async () => {
    const many = { beats: ['x'], turns: Array.from({ length: 25 }, () => ({ speaker: 'Narrator', intent: 'x' })) };
    const { chat, calls } = fakeModel({ plan: { backstage: many } });
    await expect(run(chat)).rejects.toThrow(/backstage plan has 25 turns.*4 to 7/);
    expect(calls).toHaveLength(1);
  });
});
