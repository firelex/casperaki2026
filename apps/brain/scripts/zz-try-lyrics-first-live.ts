// THROWAWAY (not committed): lyrics first on stored songs with the live model, applied in memory only.
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { applyLyricsFirst, generatorParams, orchestrate, segmentType, sungSections, vocalSelections } from '@casperaki/arrangement';
import { parseSong, type Song } from '@casperaki/song-schema';
import { OpenAiChatModel } from '../src/llm/chatModel.js';
import { drawInspiration } from '../src/lyrics/inspiration.js';
import { TYPE_LABELS, writeLyricsFirst } from '../src/lyrics/lyricsFirst.js';

const out = join(homedir(), 'Downloads', 'lyrics-first-v3');
mkdirSync(out, { recursive: true });
const model = new OpenAiChatModel({ baseUrl: process.env.ASSISTANT_LLM_URL!, model: process.env.ASSISTANT_LLM_MODEL!, ...(process.env.ASSISTANT_LLM_KEY ? { apiKey: process.env.ASSISTANT_LLM_KEY } : {}) });
const db = new Database(join(homedir(), 'casperaki-data', 'songs.sqlite'), { readonly: true, fileMustExist: true });
const find = db.prepare('select s.canonical as canonical from songs s join projects p on p.song_id = s.id where p.title = ?');
const report: string[] = ['# Lyrics first, live run', ''];
const openings: string[] = [];
for (const title of process.argv.slice(2)) {
  const song = parseSong(JSON.parse((find.get(title) as { canonical: string }).canonical));
  const params = generatorParams(song);
  const sel = vocalSelections(params);
  const types: { type: string; label: string; lines: number }[] = [];
  for (const s of orchestrate(params).songStructure) {
    const type = segmentType(s.name);
    const m = sel.get(type);
    if (!m || types.some((t) => t.type === type)) continue;
    types.push({ type, label: TYPE_LABELS[type]!, lines: (m.properties.end - m.properties.start) / 2 });
  }
  const inspiration = drawInspiration(Math.random);
  let calls = 0;
  const counted = { complete: async (m: Parameters<typeof model.complete>[0], o: Parameters<typeof model.complete>[1]) => { calls++; const a = await model.complete(m, o); if (process.env.DUMP) console.log(`--- ask ${calls}\n${m.at(-1)!.content.slice(0, 600)}\n--- answer\n${a.slice(0, 1500)}`); return a; } };
  const t0 = Date.now();
  const lyrics = await writeLyricsFirst(counted, { types, title, genre: params.genre, recentOpenings: openings, inspiration });
  const t1 = Date.now();
  const applied: Song = applyLyricsFirst(song, lyrics);
  const t2 = Date.now();
  openings.push(lyrics[types[0]!.type]![0]!);
  const chorus = sungSections(applied).find((s) => s.type === 'chorus');
  report.push(`## ${title}`, '', `*${inspiration.artist}; ${inspiration.situation}* — ${calls} model answer(s), ${((t1 - t0) / 1000).toFixed(1)} s; recut + regenerate ${((t2 - t1) / 1000).toFixed(1)} s`, '');
  for (const t of types) report.push(`**${t.label}**`, ...lyrics[t.type]!.map((l) => `${l}  `), '');
  if (chorus) {
    const bars = applied.arrangement[chorus.name]!.overrides.Vocal!.bars!;
    const notes = bars.flatMap((b, i) => Object.entries(b.notes ?? {}).flatMap(([beat, evs]) => (evs ?? []).filter((e) => e.type === 'vocalNote').map((e) => ({ at: i * 4 + Number(beat), d: (e as { duration: number }).duration, w: (e as { fullWord?: string }).fullWord ?? '' })))).sort((a, b) => a.at - b.at);
    report.push('Chorus as sung (beat: syllable, length in beats):', '', '```', notes.map((n) => `${n.at.toFixed(2).padStart(5)}  ${n.w.padEnd(10)} ${n.d}`).join('\n'), '```', '');
  }
  console.log(title, `${calls} answers ${((t1 - t0) / 1000).toFixed(1)}s, apply ${((t2 - t1) / 1000).toFixed(1)}s`);
}
writeFileSync(join(out, 'lyrics.md'), report.join('\n'));
console.log('written', join(out, 'lyrics.md'));
