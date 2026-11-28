// Writes data/patterns/proposals/guitar-strums-casperaki-pop.json: 50 guitar-strum proposals for Casperaki Pop, for
// the owner to hear and approve in the pattern lab (owner 2026-11-28: "come up with our own patterns for Casperaki
// Pop - short, choppy guitars", then "Add 50 new ones. Syncopated, choppy, energetic").
//
//   npx tsx scripts/make-casperaki-pop-strums.ts
//
// Each proposal is a 2-bar figure in two versions: a quiet one for verses (energy low, 5 to 7 strums a bar) and a busy
// one for choruses (energy high, 8 to 11 a bar, the quiet one's strums plus more). The strums are short chops (a
// sixteenth), with up to one held chord a bar (a long strum of half a beat to a beat and a half, ringing into the rest
// after it; owner 2026-11-28: "There can be longer notes in the pattern, just not a wall of sound"). Downstrokes fall
// on the beat and its "and", upstrokes on the "e" and "a", as a strumming hand moves. Half or more of every version's
// strums are off the beat, bar 2 always pushes into the next bar (a strum on the "and" or "a" of 4), and no wall of
// sound: never more than three sixteenths in a row, at least one empty half-beat a bar, nothing inside a held chord. The figures are built from one-beat cells of four sixteenths, drawn with a fixed seed, so running the
// script again writes the same file; no two figures share a rhythm.

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createRng } from '@casperaki/music-theory';

import { PROPOSALS_DIR } from '../src/patterns/proposals.js';

const COUNT = 50;
const FILE = 'guitar-strums-casperaki-pop.json';
const CHOP = 0.25;

/** One beat as four sixteenths ("x" a strum), and how often it is drawn: mostly off-beat cells. */
const CELLS: readonly (readonly [string, number])[] = [
  ['x.x.', 2], ['..x.', 4], ['.x.x', 3], ['x..x', 3], ['..xx', 3], ['.xx.', 2],
  ['x.xx', 2], ['...x', 2], ['xx.x', 1], ['.xxx', 1], ['....', 2], ['x...', 1], ['.x..', 1],
];
/** Bar 2's last beat: a push into the next bar. */
const PUSHES = ['..xx', '.x.x', '..x.', 'x.xx', '...x', '.xxx'] as const;

type Stroke = 'down' | 'up' | 'longDown' | 'longUp';
type Strum = readonly [number, Stroke, number];
/** Held chords: slot -> length in sixteenths. */
type Holds = ReadonlyMap<number, number>;

const rng = createRng('casperaki-pop-strums-2026-11-28');
const pickCell = (): string => {
  const total = CELLS.reduce((a, [, w]) => a + w, 0);
  let r = rng.next() * total;
  for (const [cell, w] of CELLS) {
    r -= w;
    if (r < 0) return cell;
  }
  return CELLS[0]![0];
};

/** Slots (sixteenths from the figure's start) of a bar made of these cells. */
const slotsOf = (cells: readonly string[], bar: number): number[] =>
  cells.flatMap((c, beat) => [...c].flatMap((ch, i) => (ch === 'x' ? [bar * 16 + beat * 4 + i] : [])));

const strumsOf = (slots: readonly number[], holds: Holds): Strum[] =>
  [...slots].sort((a, b) => a - b).map((s) => {
    const held = holds.get(s);
    const down = s % 2 === 0;
    return held ? ([s / 4, down ? 'longDown' : 'longUp', held / 4] as const) : ([s / 4, down ? 'down' : 'up', CHOP] as const);
  });

/** Never more than three sixteenths in a row, and at least one empty half-beat (two free sixteenths on an eighth) a
 *  bar, a held chord's sixteenths counted as taken. */
function airy(slots: readonly number[], holds: Holds): boolean {
  const taken = new Set<number>();
  for (const s of slots) for (let i = 0; i < (holds.get(s) ?? 1); i++) taken.add(s + i);
  let run = 0;
  for (let s = 0; s < 32; s++) {
    run = slots.includes(s) && !holds.has(s) && taken.has(s) ? run + 1 : 0;
    if (run > 3) return false;
  }
  for (const bar of [0, 1]) {
    let free = false;
    for (let s = bar * 16; s < bar * 16 + 16; s += 2) if (!taken.has(s) && !taken.has(s + 1)) free = true;
    if (!free) return false;
  }
  return true;
}

/** Up to one held chord a bar: a strum with room after it (two to six free sixteenths) held into that room, most often
 *  bar 2's push or a strum on an off-beat "and". */
function chooseHolds(slots: readonly number[]): Map<number, number> {
  const holds = new Map<number, number>();
  for (const bar of [0, 1]) {
    if (rng.next() < 0.35) continue;
    const room = slots
      .filter((s) => Math.floor(s / 16) === bar)
      .map((s) => ({ s, gap: (slots.filter((t) => t > s).sort((a, b) => a - b)[0] ?? 32 + (bar === 1 ? 2 : 0)) - s }))
      .filter((x) => x.gap >= 3);
    if (room.length === 0) continue;
    const pick = room[Math.floor(rng.next() * room.length)]!;
    holds.set(pick.s, Math.min(6, pick.gap - 1));
  }
  return holds;
}

const offBeatShare = (slots: readonly number[]) => slots.filter((s) => s % 4 !== 0).length / slots.length;
const perBar = (slots: readonly number[], bar: number) => slots.filter((s) => Math.floor(s / 16) === bar).length;

/** A quiet figure: 2 bars, 5 to 7 strums each, half or more off the beat, bar 2 ending on a push. */
function quietFigure(): number[] | undefined {
  const bar1 = [pickCell(), pickCell(), pickCell(), pickCell()];
  const bar2 = [bar1[0]!, bar1[1]!, rng.next() < 0.5 ? bar1[2]! : pickCell(), PUSHES[Math.floor(rng.next() * PUSHES.length)]!];
  const slots = [...slotsOf(bar1, 0), ...slotsOf(bar2, 1)];
  for (const bar of [0, 1]) if (perBar(slots, bar) < 5 || perBar(slots, bar) > 7) return undefined;
  if (offBeatShare(slots) < 0.5) return undefined;
  // a figure that never lands on beat 1 or 3 drifts; one that has every beat is not syncopated
  if (!slots.some((s) => s % 8 === 0)) return undefined;
  if ([0, 4, 8, 12].every((s) => slots.includes(s))) return undefined;
  return slots;
}

/** The busy figure: the quiet one plus off-beat sixteenths (mostly), 8 to 11 strums a bar, none inside a held chord,
 *  still airy. */
function busyFigure(quiet: readonly number[], holds: Holds): number[] | undefined {
  const slots = new Set(quiet);
  const inside = (s: number) => [...holds].some(([h, len]) => s > h && s < h + len);
  for (const bar of [0, 1]) {
    const want = 8 + Math.floor(rng.next() * 4);
    let guard = 0;
    while (perBar([...slots], bar) < want && guard++ < 400) {
      const s = bar * 16 + Math.floor(rng.next() * 16);
      if (s % 4 === 0 && rng.next() < 0.7) continue; // favour the off-beats
      if (slots.has(s) || inside(s)) continue;
      slots.add(s);
      if (!airy([...slots], holds)) slots.delete(s);
    }
    if (perBar([...slots], bar) < 8) return undefined;
  }
  const out = [...slots];
  return offBeatShare(out) >= 0.5 ? out : undefined;
}

const LEADS = ['Off-beat', 'Backbeat', 'Skipping', 'Pushed', 'Stabbing', 'Bouncing', 'Ghosted', 'Clipped', 'Snapping', 'Popping'];
const NOUNS = ['chops', 'scratch', 'stabs', 'strums', 'clicks'];
const beatName = (s: number) => {
  const beat = Math.floor((s % 16) / 4) + 1;
  return s % 4 === 0 ? `${beat} of bar ${Math.floor(s / 16) + 1}` : `${['', 'e', 'and', 'a'][s % 4]} of ${beat}`;
};

const proposals: object[] = [];
const seen = new Set<string>();
let tries = 0;
while (proposals.length < COUNT) {
  if (++tries > 100_000) throw new Error(`only ${proposals.length} distinct figures found`);
  const quiet = quietFigure();
  if (!quiet) continue;
  const holds = chooseHolds(quiet);
  if (!airy(quiet, holds)) continue;
  const busy = busyFigure(quiet, holds);
  if (!busy) continue;
  const key = `${[...quiet].sort((a, b) => a - b).join(',')}|${[...busy].sort((a, b) => a - b).join(',')}`;
  if (seen.has(key) || seen.has(`q:${[...quiet].sort((a, b) => a - b).join(',')}`)) continue;
  seen.add(key);
  seen.add(`q:${[...quiet].sort((a, b) => a - b).join(',')}`);
  const n = proposals.length + 1;
  const name = `${LEADS[(n - 1) % LEADS.length]} ${NOUNS[Math.floor((n - 1) / LEADS.length) % NOUNS.length]} ${String(n).padStart(2, '0')}`;
  const ups = quiet.filter((s) => s % 2 === 1).length;
  const push = quiet.filter((s) => s >= 28).map(beatName).join(' and ');
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  proposals.push({
    id: `gs-cp-choppy-${String(n).padStart(2, '0')}`,
    family: 'guitar',
    kind: 'guitarStrums',
    name,
    genres: ['casperakiPop'],
    rationale:
      `Short, choppy chord stabs over two bars${holds.size ? `, with ${holds.size === 1 ? 'a held chord' : 'two held chords'} (${[...holds].map(([h, len]) => `on the ${beatName(h)}, ${len / 4} beat${len === 4 ? '' : 's'}`).join('; ')}) ringing into a rest` : ', every strum a sixteenth long'}. The quiet version (verses) plays ` +
      `${perBar(quiet, 0)} and ${perBar(quiet, 1)} strums in its two bars, ${pct(offBeatShare(quiet))} of them off the ` +
      `beat and ${ups} of them upstrokes, and pushes into the next bar on the ${push}. The busy version (choruses) keeps ` +
      `those and adds off-beat sixteenths: ${perBar(busy, 0)} and ${perBar(busy, 1)} strums, ${pct(offBeatShare(busy))} ` +
      `off the beat.`,
    patterns: [
      { bars: 2, energy: 'low', strums: strumsOf(quiet, holds) },
      { bars: 2, energy: 'high', strums: strumsOf(busy, holds) },
    ],
  });
}

writeFileSync(resolve(PROPOSALS_DIR, FILE), `${JSON.stringify(proposals, null, 1)}\n`);
console.log(`wrote ${proposals.length} proposals to ${FILE} (${tries} figures drawn)`);
