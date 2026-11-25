// Export pattern-lab approvals into the pattern library (the repo's bank files):
// makes data/patterns/drums/, data/patterns/bass/ and data/patterns/authored/
// match the approved proposals.
//   Keys, pad, strings, brass, synths, plucked synths, guitar: an entry in
//     authored/index.json (offered alongside the family's own generator).
//   Drums: every approved proposal becomes a style "authored-<id>" (a bank file
//     under authored/ for fixed blueprints, or an { authoredAlgo } entry for a
//     generator) listed in its genres' genreStyles.
//   Bass: an entry in bank-index.json `authored` (offered alongside the genre's
//     legacy bass styles).
// Styles of proposals no longer approved are removed. Legacy styles are never
// touched. After a real export the in-memory banks are dropped, so the next
// song uses the new library.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { AUTHORED_BANK_DIR, _resetAuthoredBankCache } from './authored-bank.js';
import { _resetBassBankCache } from './bass-bank.js';
import { _resetDrumBankCache } from './drums-bank.js';
import { authoredStyleName, BASS_BANK_DIR, DRUM_BANK_DIR, loadPatternProposals, PROPOSALS_DIR } from './proposals.js';

export interface PatternLibraryDirs {
  readonly proposals: string;
  readonly drums: string;
  readonly bass: string;
  readonly authored: string;
}

export const PATTERN_LIBRARY_DIRS: PatternLibraryDirs = { proposals: PROPOSALS_DIR, drums: DRUM_BANK_DIR, bass: BASS_BANK_DIR, authored: AUTHORED_BANK_DIR };

/** What changed in the library, one line per change (empty: already up to date). */
export function exportApprovedPatterns(approved: ReadonlySet<string>, opts: { dryRun?: boolean; dirs?: PatternLibraryDirs } = {}): string[] {
  const dryRun = opts.dryRun ?? false;
  const dirs = opts.dirs ?? PATTERN_LIBRARY_DIRS;
  const proposals = loadPatternProposals(dirs.proposals).filter((p) => approved.has(p.id));
  const missing = [...approved].filter((id) => !proposals.some((p) => p.id === id));
  if (missing.length) throw new Error(`approved proposals no longer on disk: ${missing.join(', ')}`);

  const drumProposals = proposals.filter((p) => p.family === 'drums');
  const bassProposals = proposals.filter((p) => p.family === 'bass');
  const laneProposals = proposals.flatMap((p) => (p.kind === 'chordTones' || p.kind === 'guitarPicks' || p.kind === 'guitarStrums' ? [p] : []));
  const changes: string[] = [];

  // ---- keys, pad, strings, brass, synths, plucked synths, guitar: authored/index.json ----
  {
    const indexPath = join(dirs.authored, 'index.json');
    const index = JSON.parse(readFileSync(indexPath, 'utf8')) as {
      styles: Record<string, { family: string; kind: string; genres: string[]; file: string }>;
    };
    const stylesDir = join(dirs.authored, 'styles');
    const wanted = new Map(laneProposals.map((p) => [authoredStyleName(p.id), p]));
    const styles: typeof index.styles = {};
    for (const [style, p] of wanted) {
      const file = `styles/${p.id}.json`;
      styles[style] = { family: p.family, kind: p.kind, genres: [...p.genres], file };
      if (!index.styles[style]) changes.push(`${p.family}: + ${style} (${p.genres.join(', ')})`);
      if (!dryRun) {
        mkdirSync(stylesDir, { recursive: true });
        writeFileSync(join(dirs.authored, file), JSON.stringify(p.patterns, null, 2) + '\n');
      }
    }
    for (const style of Object.keys(index.styles)) if (!wanted.has(style)) changes.push(`${index.styles[style]!.family}: removed ${style}`);
    if (existsSync(stylesDir)) {
      for (const f of readdirSync(stylesDir)) {
        if (!wanted.has(authoredStyleName(f.replace(/\.json$/u, '')))) {
          if (!dryRun) rmSync(join(stylesDir, f));
          changes.push(`deleted authored/styles/${f}`);
        }
      }
    }
    index.styles = styles;
    if (!dryRun) writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n');
  }

  // ---- bass: bank-index.json `authored` (offered alongside the legacy styles) ----
  {
    const indexPath = join(dirs.bass, 'bank-index.json');
    const index = JSON.parse(readFileSync(indexPath, 'utf8')) as { authored?: Record<string, { file: string; genres: string[] }> };
    const authoredDir = join(dirs.bass, 'authored');
    const wanted = new Map(bassProposals.map((p) => [authoredStyleName(p.id), p]));
    const authored: Record<string, { file: string; genres: string[] }> = {};
    for (const [style, p] of wanted) {
      const file = `authored/${p.id}.json`;
      authored[style] = { file, genres: [...p.genres] };
      if (!index.authored?.[style]) changes.push(`bass: + ${style} (${p.genres.join(', ')})`);
      if (!dryRun) {
        mkdirSync(authoredDir, { recursive: true });
        writeFileSync(join(dirs.bass, file), JSON.stringify(p.patterns, null, 2) + '\n');
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
  {
    const indexPath = join(dirs.drums, 'bank-index.json');
    const index = JSON.parse(readFileSync(indexPath, 'utf8')) as {
      styles: Record<string, Record<string, string>>;
      genreStyles: Record<string, string[]>;
    };
    const authoredDir = join(dirs.drums, 'authored');
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
          writeFileSync(join(dirs.drums, file), JSON.stringify(p.blueprints, null, 2) + '\n');
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
  }

  if (!dryRun) {
    _resetAuthoredBankCache();
    _resetBassBankCache();
    _resetDrumBankCache();
  }
  return changes;
}
