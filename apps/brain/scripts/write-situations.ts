// Writes src/lyrics/situations.json: one-line premises for pop songs, the "what the song is about" that each new
// lyric draws one of (src/lyrics/inspiration.ts). Run once; the owner prunes the file when convenient.
//
//   set -a; . ~/.config/casperaki/brain.env; set +a
//   tsx scripts/write-situations.ts

import { writeFileSync } from 'node:fs';

import { OpenAiChatModel } from '../src/llm/chatModel.js';
import { SITUATIONS_FILE } from '../src/lyrics/inspiration.js';

const url = process.env.ASSISTANT_LLM_URL;
const modelName = process.env.ASSISTANT_LLM_MODEL;
if (!url || !modelName) throw new Error('set ASSISTANT_LLM_URL and ASSISTANT_LLM_MODEL (the brain env)');
const model = new OpenAiChatModel({ baseUrl: url, model: modelName, ...(process.env.ASSISTANT_LLM_KEY ? { apiKey: process.env.ASSISTANT_LLM_KEY } : {}) });

const EXAMPLES = [
  'getting over an ex and having the best night out without them',
  'a crush who does not know you exist',
  'a text you should not send at 2 a.m.',
  'not being invited and not caring',
  'falling for your best friend',
];
const THEMES = ['love and crushes', 'breakups and getting over someone', 'nights out, parties and dancing', 'friendship, freedom and growing up', 'confidence, revenge and attitude', 'longing, distance and missing someone'];

const all = new Set<string>();
for (const theme of THEMES) {
  const prompt = `List 45 different situations a contemporary chart pop song could be about, on the theme "${theme}". Each is one short line (6 to 16 words) saying what the song is about, concrete and relatable, the way these examples are: ${EXAMPLES.map((e) => `"${e}"`).join(', ')}. Every situation must be clearly different from the others: a different moment, place or feeling. No song titles, no names of real people or brands. Answer with JSON only: {"situations": ["...", "..."]}`;
  const text = await model.complete([{ role: 'user', content: prompt }], { thinking: false });
  const parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/gu, '')) as { situations: unknown };
  if (!Array.isArray(parsed.situations)) throw new Error(`the model answered without a list for "${theme}": ${text.slice(0, 200)}`);
  for (const s of parsed.situations) if (typeof s === 'string' && s.trim().length >= 8) all.add(s.trim().replace(/\.$/u, '').replace(/^./u, (c) => c.toLowerCase()));
  console.log(theme, all.size);
}
writeFileSync(SITUATIONS_FILE, `${JSON.stringify([...all], null, 1)}\n`);
console.log(`${all.size} situations written to ${SITUATIONS_FILE}`);
