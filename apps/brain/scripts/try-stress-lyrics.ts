// Writes new lyrics with the live language model for stored songs' melodies and measures them, without changing the
// stored songs (the store is opened read-only; nothing is written back). Per song: the writer's model calls and
// seconds, the versions it got and how many passed the melody checks, whether every line could be fitted, and the
// new words scored against the old lyric writer's stress rules as sung (lyric-stress-score.ts: the lyrics applied to
// the song as the app applies them, each syllable graded on its note), next to the words the song has now.
//
//   set -a; . ~/.config/casperaki/brain.env; set +a
//   tsx scripts/try-stress-lyrics.ts "<song title>"... [--out <file.json>]
//   (env LYRICS_DUMP=<file>: append every request's last message and the answer to that file)

import { appendFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { applyWrittenLyrics, generatorParams, orchestrate, sungSections, WRITTEN_LYRICS_PARAM, type WrittenLyrics } from '@casperaki/arrangement';
import { parseSong, type Song } from '@casperaki/song-schema';

import { OpenAiChatModel, type ChatMessage, type ChatModel } from '../src/llm/chatModel.js';
import { writeLyrics, type LyricsRun } from '../src/lyrics/lyricist.js';
import { scoreAsSung } from './lyric-stress-score.js';

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const out = outAt >= 0 ? args[outAt + 1] : undefined;
const titles = args.filter((a, i) => a !== '--out' && i !== outAt + 1);
if (titles.length === 0) throw new Error('name the songs to write lyrics for (their titles)');
const url = process.env.ASSISTANT_LLM_URL;
const modelName = process.env.ASSISTANT_LLM_MODEL;
if (!url || !modelName) throw new Error('set ASSISTANT_LLM_URL and ASSISTANT_LLM_MODEL (the brain env)');
const live = new OpenAiChatModel({ baseUrl: url, model: modelName, ...(process.env.ASSISTANT_LLM_KEY ? { apiKey: process.env.ASSISTANT_LLM_KEY } : {}) });

/** The live model, timing each call by kind. */
const calls: { kind: string; thinking: boolean; seconds: number }[] = [];
const timed: ChatModel = {
  async complete(messages: readonly ChatMessage[], options: { readonly thinking: boolean }) {
    const t = Date.now();
    const text = await live.complete(messages, options);
    if (process.env.LYRICS_DUMP) appendFileSync(process.env.LYRICS_DUMP, `\n===== ${options.thinking ? 'reasoning ' : ''}request\n${messages.at(-1)!.content.slice(0, 6000)}\n----- answer\n${text}\n`);
    calls.push({ kind: messages[0]!.content.includes('careful editor') ? 'grammar' : messages.length > 2 ? 'repair' : 'draft', thinking: options.thinking, seconds: (Date.now() - t) / 1000 });
    return text;
  },
};

const db = new Database(join(homedir(), 'casperaki-data', 'songs.sqlite'), { readonly: true, fileMustExist: true });
const find = db.prepare('select s.canonical as canonical from songs s join projects p on p.song_id = s.id where p.title = ?');

/** The song's generator params without its written words (they are what is being replaced). */
function withoutLyrics(song: Song) {
  const gp = generatorParams(song);
  const { [WRITTEN_LYRICS_PARAM]: _old, ...params } = (gp.params ?? {}) as Record<string, unknown>;
  return { ...gp, params };
}

const report: unknown[] = [];
for (const title of titles) {
  const row = find.get(title) as { canonical: string } | undefined;
  if (!row) throw new Error(`no stored song called "${title}"`);
  const stored = parseSong(JSON.parse(row.canonical));
  const generated = orchestrate(withoutLyrics(stored));
  const sections = sungSections(generated).map((s) => s.name);
  const before = (generator: Song) => {
    const p = (generator.generator?.params as { params?: Record<string, unknown> } | undefined)?.params?.[WRITTEN_LYRICS_PARAM] as WrittenLyrics | undefined;
    return p;
  };
  calls.length = 0;
  const run: LyricsRun = { writes: 0, readings: 0, versions: 0, passing: 0 };
  const t0 = Date.now();
  let lyrics: WrittenLyrics | undefined;
  let error: string | undefined;
  try {
    lyrics = await writeLyrics(generated, timed, { sections, title }, run);
  } catch (e) {
    error = (e as Error).message;
  }
  const seconds = (Date.now() - t0) / 1000;
  // Applied as the app applies them (a sung take of the sections is dropped, the vocal tracks regenerated).
  const score = lyrics ? scoreAsSung(applyWrittenLyrics(stored, lyrics), title, lyrics) : undefined;
  const lines = sungSections(generated).reduce((n, s) => n + s.lines.length, 0);
  const entry = {
    title,
    genre: stored.genre,
    sections: sections.length,
    lines,
    seconds,
    calls: calls.map((c) => `${c.kind}${c.thinking ? '+reasoning' : ''} ${c.seconds.toFixed(1)}s`),
    run,
    error,
    asSung: score && { words: score.words, clashingWords: score.clashingWords, clashingLines: score.clashingLines, lines: score.lines, clashes: score.clashes },
    before: before(stored),
    after: lyrics,
  };
  report.push(entry);
  console.log(
    `${title} (${stored.genre}): ${error ? 'FAILED' : 'ok'} in ${seconds.toFixed(1)} s, ${run.writes} writing + ${run.readings} grammar calls, ${run.passing}/${run.versions} versions passed; ` +
      (score ? `as sung ${score.clashingWords}/${score.words} words against the stress, ${score.clashingLines}/${score.lines} lines` : ''),
  );
  console.log(`  calls: ${entry.calls.join(', ')}`);
  if (error) console.log(`  ${error.split('\n').join('\n  ')}`);
  if (out) writeFileSync(out, JSON.stringify(report, null, 2));
}
