// Writes src/titles/titles.json: about 1,000 invented chart-pop song titles, the examples each new song's title is
// written after (a dozen drawn at random per song, src/titles/songTitler.ts), as situations.json is for lyrics
// (owner 2026-11-28: "the automatically chosen song titles should be more pop. Can we prepare a list of 1,000 possible
// pop titles and then give DeepSeek references like we do for the lyrics"). Run once; the owner prunes the file when
// convenient.
//
//   set -a; . ~/.config/casperaki/brain.env; set +a
//   tsx scripts/write-titles.ts

import { writeFileSync } from 'node:fs';

import { OpenAiChatModel } from '../src/llm/chatModel.js';
import { TITLES_FILE, MAX_TITLE_WORDS } from '../src/titles/titleBank.js';

const url = process.env.ASSISTANT_LLM_URL;
const modelName = process.env.ASSISTANT_LLM_MODEL;
if (!url || !modelName) throw new Error('set ASSISTANT_LLM_URL and ASSISTANT_LLM_MODEL (the brain env)');
const model = new OpenAiChatModel({ baseUrl: url, model: modelName, ...(process.env.ASSISTANT_LLM_KEY ? { apiKey: process.env.ASSISTANT_LLM_KEY } : {}) });

const TARGET = 1000;
const EXAMPLES = ['Bad Idea', 'Kiss Me Back', 'Not Your Girl', 'Call Me Later', 'Too Much Tonight', 'Say It First'];
const THEMES = [
  'falling in love and crushes',
  'breakups and getting over someone',
  'nights out, parties and dancing',
  'confidence, attitude and revenge',
  'missing someone and long distance',
  'friendship, freedom and growing up',
  'summer, holidays and road trips',
  'flirting, texting and mixed signals',
  'heartbreak and jealousy',
  'self-love and starting over',
  'secrets, lies and second chances',
  'wild weekends and living for the moment',
];

const all = new Map<string, string>();
const words = (t: string) => t.split(/\s+/u).filter(Boolean).length;
for (let round = 0; all.size < TARGET && round < 6; round++) {
  for (const theme of THEMES) {
    if (all.size >= TARGET) break;
    const prompt = [
      `List 40 different song titles for contemporary chart pop songs on the theme "${theme}".`,
      `Each is one to ${MAX_TITLE_WORDS} words of everyday English: a catchy phrase someone would say or sing, the kind a chorus is built on, like ${EXAMPLES.map((e) => `"${e}"`).join(', ')}.`,
      'Invent them: none may be the title of a well-known existing song. No poetic images, no place names, no names of people or brands, no numbers written as digits.',
      'Every title must be clearly different from the others.',
      'Answer with JSON only: {"titles": ["...", "..."]}',
    ].join(' ');
    const text = await model.complete([{ role: 'user', content: prompt }], { thinking: false });
    const parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/gu, '')) as { titles: unknown };
    if (!Array.isArray(parsed.titles)) throw new Error(`the model answered without a list for "${theme}": ${text.slice(0, 200)}`);
    for (const t of parsed.titles) {
      if (typeof t !== 'string') continue;
      const title = t.trim().replace(/^["'“”]+|["'“”.]+$/gu, '').trim();
      if (!title || words(title) > MAX_TITLE_WORDS || /\d/u.test(title)) continue;
      const key = title.toLowerCase().replace(/[^a-z' ]/gu, '');
      if (!all.has(key)) all.set(key, title);
    }
    console.log(`${theme}: ${all.size}`);
  }
}
if (all.size < TARGET) throw new Error(`only ${all.size} different titles after six rounds (wanted ${TARGET})`);
writeFileSync(TITLES_FILE, `${JSON.stringify([...all.values()].slice(0, TARGET), null, 1)}\n`);
console.log(`${TARGET} titles written to ${TITLES_FILE}`);
