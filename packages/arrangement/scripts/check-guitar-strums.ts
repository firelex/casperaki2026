// Check guitar-strum proposals (pattern lab kind `guitarStrums`) before review.
//
//   npx tsx scripts/check-guitar-strums.ts [proposals-file ...]
//
// Every proposal file must load (schema, verse and chorus patterns, guitar playable in its genres). Then, for the
// guitarStrums proposals (all of them, or those in the named files):
//   - beats on a sixteenth or eighth-triplet grid;
//   - no two patterns with the same rhythm (strum onsets and strokes), within or across proposals;
//   - no pattern whose every bar copies a bar of the legacy Virtual Guitarist bank;
//   - a busy pattern (energy high) has more strums per bar than its style's quiet one (energy low).
// Prints a count per genre and exits 1 on any problem.

import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import { loadPatternProposals, PROPOSALS_DIR } from '../src/patterns/proposals.js';
import type { GuitarStrumPattern } from '../src/patterns/chord-tones.js';

const files = process.argv.slice(2).map((f) => basename(f));
const all = loadPatternProposals();
const fileOf = new Map<string, string>();
for (const f of files) {
  for (const p of JSON.parse(readFileSync(resolve(PROPOSALS_DIR, f), 'utf8')) as { id: string }[]) fileOf.set(p.id, f);
}
const strumProposals = all.flatMap((p) => (p.kind === 'guitarStrums' ? [p] : []));
const checked = files.length ? strumProposals.filter((p) => fileOf.has(p.id)) : strumProposals;

const problems: string[] = [];
const onGrid = (beat: number) => [0.25, 1 / 3].some((step) => Math.abs(beat / step - Math.round(beat / step)) < 1e-4);
const r = (x: number) => Math.round(x * 1000) / 1000;

const barKey = (pattern: GuitarStrumPattern, bar: number) =>
  pattern.strums
    .filter(([beat]) => Math.floor(beat / 4) === bar)
    .map(([beat, stroke]) => `${r(beat - bar * 4)}${stroke.startsWith('long') ? 'L' : ''}${stroke.endsWith('own') || stroke === 'down' ? 'd' : 'u'}`)
    .sort()
    .join(' ');
const patternKey = (pattern: GuitarStrumPattern) => Array.from({ length: pattern.bars }, (_, b) => barKey(pattern, b)).join(' | ');

// Legacy bank bars, in the same notation.
const legacyBars = new Set<string>();
const LEGACY_EVENTS: Record<string, string> = {
  chordShortStrumDown: 'd',
  chordShortStrumUp: 'u',
  chordLongStrumDown: 'Ld',
  chordLongStrumUp: 'Lu',
};
for (const name of ['virtualGuitaristPatterns.json', 'virtualGuitaristStefanPatterns.json']) {
  const bank = JSON.parse(readFileSync(resolve(PROPOSALS_DIR, '..', 'guitar', name), 'utf8')) as Record<
    string,
    { notes: Record<string, { type: string; event?: string }[]> }[]
  >;
  for (const bars of Object.values(bank)) {
    for (const bar of bars) {
      const key = Object.entries(bar.notes)
        .flatMap(([beat, events]) => events.flatMap((e) => (e.type === 'virtualGuitarist' && e.event && LEGACY_EVENTS[e.event] ? [`${r(Number(beat))}${LEGACY_EVENTS[e.event]}`] : [])))
        .sort()
        .join(' ');
      if (key) legacyBars.add(key);
    }
  }
}

const seen = new Map<string, string>();
for (const p of strumProposals) {
  p.patterns.forEach((pattern, i) => {
    const where = `${p.id} pattern ${i + 1}`;
    const key = patternKey(pattern);
    const before = seen.get(key);
    if (before && checked.includes(p)) problems.push(`${where}: same rhythm as ${before}`);
    if (!before) seen.set(key, where);
    if (!checked.includes(p)) return;
    for (const [beat] of [...pattern.strums, ...(pattern.picks ?? []), ...(pattern.fx ?? [])]) {
      if (!onGrid(beat)) problems.push(`${where}: beat ${beat} is off the sixteenth / triplet grid`);
    }
    const bars = Array.from({ length: pattern.bars }, (_, b) => barKey(pattern, b)).filter((k) => k !== '');
    if (bars.length > 0 && bars.every((k) => legacyBars.has(k))) problems.push(`${where}: every bar copies a legacy bank bar`);
  });
  if (!checked.includes(p)) continue;
  const perBar = (energy: string) => {
    const ps = p.patterns.filter((x) => x.energy === energy);
    return ps.length ? Math.min(...ps.map((x) => x.strums.length / x.bars)) : undefined;
  };
  const low = p.patterns.filter((x) => x.energy === 'low').map((x) => x.strums.length / x.bars);
  const high = perBar('high');
  if (low.length && high !== undefined && high <= Math.max(...low)) {
    problems.push(`${p.id}: its busiest quiet pattern has as many strums per bar as its sparsest busy one`);
  }
}

const perGenre = new Map<string, number>();
for (const p of checked) for (const g of p.genres) perGenre.set(g, (perGenre.get(g) ?? 0) + 1);
console.log(`guitarStrums proposals checked: ${checked.length}`);
for (const [g, n] of [...perGenre].sort()) console.log(`  ${g}: ${n}`);
if (problems.length) {
  console.log(`\n${problems.length} problem(s):`);
  for (const line of problems) console.log(`  - ${line}`);
  process.exit(1);
}
console.log('no problems');
