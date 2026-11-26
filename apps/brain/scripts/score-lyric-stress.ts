// Scores the words of stored songs against the old lyric writer's stress rules, without changing anything (the song
// store is opened read-only). Two counts per song:
//   - "as sung" (lyric-stress-score.ts): the syllables as the stored notes sing them, each graded on its note as
//     stored; this is what an old-rules scorer sees, so it can be compared with one;
//   - "check": the lyric checker's verdict on the written lines (lineStressClashes: the line as the writer plans it on
//     its notes now). Sections whose melody changed after the words were written are named, not scored.
//
//   tsx scripts/score-lyric-stress.ts [path to songs.sqlite] [--all] [--list]
//   (default ~/casperaki-data/songs.sqlite; --all also scores songs singing phrase-bank words; --list prints every word
//   sung against its stress as "song|section|bar|beat|word")

import { homedir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { lineStressClashes, sungSections, writtenLyricsOf } from '@casperaki/arrangement';
import type { Song } from '@casperaki/song-schema';

import { scoreAsSung } from './lyric-stress-score.js';

const args = process.argv.slice(2);
const all = args.includes('--all');
const list = args.includes('--list');
const path = args.find((a) => !a.startsWith('--')) ?? join(homedir(), 'casperaki-data', 'songs.sqlite');
const db = new Database(path, { readonly: true, fileMustExist: true });
const rows = db.prepare('select p.title as title, s.canonical as canonical from songs s join projects p on p.song_id = s.id').all() as { title: string; canonical: string }[];

const totals = { words: 0, clashingWords: 0, clashingSyllables: 0, lines: 0, clashingLines: 0, checkLines: 0, checkClashingLines: 0, checkClashes: 0 };
for (const { title, canonical } of rows) {
  if (!canonical.includes('"fullWord"')) continue;
  const song = JSON.parse(canonical) as Song;
  const written = writtenLyricsOf((song.generator?.params as { params?: Record<string, unknown> } | undefined)?.params);
  if (Object.keys(written).length === 0 && !all) continue;
  const t = scoreAsSung(song, title, written);
  if (list) for (const c of t.clashes) console.log(`LIST|${title}|${c.section}|${c.bar}|${c.beat}|${c.word}`);
  const check = { lines: 0, clashingLines: 0, clashes: 0 };
  const unfit: string[] = [];
  const checked = new Set<string>();
  for (const s of sungSections(song)) {
    const text = written[s.name];
    if (!text) continue;
    if (text.length !== s.lines.length) {
      unfit.push(`${s.name}: ${text.length} lines written for the ${s.lines.length} lyric lines its melody has now`);
      continue;
    }
    const key = JSON.stringify([s.lines.map((l) => l.map((x) => [x.start, x.duration])), text]);
    if (checked.has(key)) continue;
    checked.add(key);
    text.forEach((line, i) => {
      const c = lineStressClashes(line, s.lines[i]!);
      if (!c) {
        unfit.push(`${s.name} line ${i + 1}: "${line}" does not fit its ${s.lines[i]!.length} notes now`);
        return;
      }
      check.lines++;
      if (c.length > 0) check.clashingLines++;
      check.clashes += c.length;
    });
  }
  console.log(
    `${Object.keys(written).length > 0 ? '[written]' : '[phrase bank]'} ${title}: as sung ${t.clashingWords}/${t.words} words against the stress (${t.clashingSyllables} syllables), ${t.clashingLines}/${t.lines} lines; check ${check.clashingLines}/${check.lines} lines, ${check.clashes} syllables`,
  );
  for (const c of t.clashes.slice(0, 4)) console.log(`    ${c.section} bar ${c.bar}: "${c.word}" (${c.rhythm}) on ${c.grades}`);
  for (const u of unfit) console.log(`    not scored by the check (the melody changed after the words were written): ${u}`);
  totals.words += t.words;
  totals.clashingWords += t.clashingWords;
  totals.clashingSyllables += t.clashingSyllables;
  totals.lines += t.lines;
  totals.clashingLines += t.clashingLines;
  totals.checkLines += check.lines;
  totals.checkClashingLines += check.clashingLines;
  totals.checkClashes += check.clashes;
}
console.log(
  `\nTotal: as sung ${totals.clashingWords}/${totals.words} words against the stress (${totals.clashingSyllables} syllables), ${totals.clashingLines}/${totals.lines} lines with a clash; ` +
    `check ${totals.checkClashingLines}/${totals.checkLines} lines, ${totals.checkClashes} syllables`,
);
