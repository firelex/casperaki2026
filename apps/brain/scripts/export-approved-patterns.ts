// Export pattern-lab approvals into the pattern library (the repo's bank files).
//
//   cd apps/brain && set -a && . ~/.config/casperaki/brain.env && set +a
//   node_modules/.bin/tsx scripts/export-approved-patterns.ts [--dry-run]
//
// Reads the review decisions from the brain's songs database and the
// proposals from packages/arrangement/data/patterns/proposals/, then makes
// data/patterns/drums/ and data/patterns/bass/ match. Drums: every approved proposal becomes a style
// "authored-<id>" (a bank file under authored/ for fixed blueprints, or an
// { authoredAlgo } entry for a generator) listed in its genres'
// genreStyles. Bass: an entry in bank-index.json `authored` (offered alongside the
// genre's legacy bass styles). Styles of proposals no longer approved are removed. Legacy
// styles are never touched. Commit the result (and rebuild the arrangement
// package) to put the patterns into new songs.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { authoredStyleName, BASS_BANK_DIR, DRUM_BANK_DIR, loadPatternProposals } from '@casperaki/arrangement';

import { openSongsStore } from '../src/store.js';

const dryRun = process.argv.includes('--dry-run');
const dbPath = process.env.BRAIN_SONGS_DB_PATH;
if (!dbPath) throw new Error('BRAIN_SONGS_DB_PATH is not set: source brain.env first.');

const store = openSongsStore({ path: dbPath });
const approved = new Set(store.listPatternReviews().filter((r) => r.status === 'approved').map((r) => r.proposalId));
store.close();
const proposals = loadPatternProposals().filter((p) => approved.has(p.id));
const missing = [...approved].filter((id) => !proposals.some((p) => p.id === id));
if (missing.length) throw new Error(`approved proposals no longer on disk: ${missing.join(', ')}`);

const drumProposals = proposals.filter((p) => p.family === 'drums');
const bassProposals = proposals.filter((p) => p.family === 'bass');
const changes: string[] = [];

// ---- bass: bank-index.json `authored` (offered alongside the legacy styles) ----
{
  const indexPath = join(BASS_BANK_DIR, 'bank-index.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8')) as { authored?: Record<string, { file: string; genres: string[] }> };
  const authoredDir = join(BASS_BANK_DIR, 'authored');
  const wanted = new Map(bassProposals.map((p) => [authoredStyleName(p.id), p]));
  const authored: Record<string, { file: string; genres: string[] }> = {};
  for (const [style, p] of wanted) {
    const file = `authored/${p.id}.json`;
    authored[style] = { file, genres: [...p.genres] };
    if (!index.authored?.[style]) changes.push(`bass: + ${style} (${p.genres.join(', ')})`);
    if (!dryRun) {
      mkdirSync(authoredDir, { recursive: true });
      writeFileSync(join(BASS_BANK_DIR, file), JSON.stringify(p.patterns, null, 2) + '\n');
    }
  }
  for (const style of Object.keys(index.authored ?? {})) if (!wanted.has(style)) changes.push(`bass: removed ${style}`);
  if (existsSync(authoredDir)) {
    for (const f of readdirSync(authoredDir)) {
      if (!wanted.has(authoredStyleName(f.replace(/\.json$/u, '')))) {
        if (!dryRun) rmSync(join(authoredDir, f));
        changes.push(`bass: deleted authored/${f}`);
      }
    }
  }
  if (Object.keys(authored).length) index.authored = authored;
  else delete index.authored;
  if (!dryRun) writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n');
}

// ---- drums: authored-<id> styles in genreStyles ----
const indexPath = join(DRUM_BANK_DIR, 'bank-index.json');
const index = JSON.parse(readFileSync(indexPath, 'utf8')) as {
  styles: Record<string, Record<string, string>>;
  genreStyles: Record<string, string[]>;
};
const authoredDir = join(DRUM_BANK_DIR, 'authored');
const isAuthored = (style: string) => style.startsWith('authored-');
const wanted = new Map(drumProposals.map((p) => [authoredStyleName(p.id), p]));

// Drop styles whose proposal is no longer approved.
for (const style of Object.keys(index.styles).filter(isAuthored)) {
  if (wanted.has(style)) continue;
  delete index.styles[style];
  for (const list of Object.values(index.genreStyles)) {
    const i = list.indexOf(style);
    if (i >= 0) list.splice(i, 1);
  }
  changes.push(`removed ${style}`);
}

// Add or refresh approved ones.
for (const [style, p] of wanted) {
  if (p.kind === 'algo') {
    index.styles[style] = { authoredAlgo: p.algo };
  } else if (p.kind === 'blueprints') {
    const file = `authored/${p.id}.json`;
    index.styles[style] = { file };
    if (!dryRun) {
      mkdirSync(authoredDir, { recursive: true });
      writeFileSync(join(DRUM_BANK_DIR, file), JSON.stringify(p.blueprints, null, 2) + '\n');
    }
  } else {
    const unexpected: never = p;
    throw new Error(`unexpected drum proposal: ${JSON.stringify(unexpected)}`);
  }
  for (const genre of p.genres) {
    const list = (index.genreStyles[genre] ??= []);
    if (!list.includes(style)) {
      list.push(style);
      changes.push(`${genre}: + ${style}`);
    }
  }
}

// Bank files of styles that are gone.
if (existsSync(authoredDir)) {
  for (const f of readdirSync(authoredDir)) {
    if (!wanted.has(authoredStyleName(f.replace(/\.json$/u, '')))) {
      if (!dryRun) rmSync(join(authoredDir, f));
      changes.push(`deleted authored/${f}`);
    }
  }
}

if (!dryRun) writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n');
console.log(`${dryRun ? '[dry run] ' : ''}${approved.size} approved; ${changes.length ? changes.join('\n') : 'library already up to date'}`);
