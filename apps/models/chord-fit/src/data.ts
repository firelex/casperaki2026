// Loads the vocal precedents (melody + chords) and the 79-entry chord bank through the arrangement package's own
// loaders, and turns them into chord-fit's 16-slot grid. Node-only (reads files).

import { loadChordBank, resolveBankEntry } from '../../../../packages/arrangement/dist/index.js';
// Not re-exported from the package index; the built module is imported directly.
import { loadPrecedentBank } from '../../../../packages/arrangement/dist/vocals/precedents.js';
import { parseKey } from '../../../../packages/music-theory/dist/index.js';

import { chordId, parseChordSymbol, parsePc } from './chords.js';
import { BARS, SLOT_BEATS, SLOTS, SLOTS_PER_BAR, type KnownProgression, type MelodyNote } from './model.js';

/** Banks that carry chords. The rhythmic-* banks have empty chord maps. */
export const CHORD_BANKS = ['drLuke', 'limitedRange', 'schlager', 'stefan'] as const;
export type ChordBankId = (typeof CHORD_BANKS)[number];

export interface Item {
  readonly id: string;
  readonly bank: ChordBankId;
  readonly name: string;
  readonly family: string;
  /** 'songs' = drLuke/limitedRange/schlager (real songs); 'stefan' = generated melodies over 20 loop progressions. */
  readonly group: 'songs' | 'stefan';
  readonly tonicPc: number;
  readonly tempo: number;
  readonly notes: readonly MelodyNote[];
  /** SLOTS chord ids, relative to the tonic. */
  readonly chords: readonly string[];
  /** Did the original change chord in the middle of each bar? */
  readonly midBarChanges: number;
}

export const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/gu, '');

export interface LoadReport {
  readonly dropped: { id: string; reason: string }[];
  readonly pickupNotesDropped: number;
  readonly offGridChordChanges: number;
}

export function loadItems(): { items: Item[]; report: LoadReport } {
  const items: Item[] = [];
  const dropped: { id: string; reason: string }[] = [];
  let pickupNotesDropped = 0;
  let offGridChordChanges = 0;
  for (const bank of CHORD_BANKS) {
    const precs = loadPrecedentBank(bank);
    // Stefan's names are "Melody <k> melodysauceimported<n>.mid": the generator wrote batches of variants
    // (k = 1, 2, 3, ... restarting at 1). A batch is one family so its variants stay on one side of the split.
    const stefanBatch = new Map<string, string>();
    if (bank === 'stefan') {
      const rows = precs.map((p) => {
        const name = String(p.properties.name);
        const m = /^Melody (\d+) melodysauceimported(\d+)\.mid$/u.exec(name);
        if (!m) throw new Error(`stefan precedent with unexpected name "${name}"`);
        return { name, k: Number(m[1]), n: Number(m[2]) };
      }).sort((a, b) => a.n - b.n || a.k - b.k);
      let batch = -1;
      let prevK = Infinity;
      for (const r of rows) {
        if (r.k <= prevK) batch++;
        prevK = r.k;
        stefanBatch.set(r.name, `stefan-batch-${batch}`);
      }
    }
    for (const p of precs) {
      const id = `${bank}#${p.id}`;
      const props = p.properties;
      const name = String(props.name);
      if (props.end - props.start !== BARS) { dropped.push({ id, reason: `${props.end - props.start} bars, need ${BARS}` }); continue; }
      if (props.key === undefined) throw new Error(`${id}: no key`);
      const key = parseKey(props.key);
      if (key.mode !== 'major') throw new Error(`${id}: key ${props.key} is not major`);
      const offset = props.start * 4;
      const notes: MelodyNote[] = [];
      for (const [b, ns] of Object.entries(p.melody)) {
        const beat = parseFloat(b) - offset;
        for (const n of ns) {
          if (beat < 0) { pickupNotesDropped++; continue; }
          if (beat >= BARS * 4) throw new Error(`${id}: note at beat ${b} past bar ${BARS}`);
          notes.push({ beat, midi: n.midi, duration: Math.min(n.duration, BARS * 4 - beat) });
        }
      }
      if (notes.length === 0) throw new Error(`${id}: no melody notes`);
      const beatChord = (beat: number) => {
        const e = p.chords[(beat + offset).toFixed(1)];
        if (!e) throw new Error(`${id}: no chord at beat ${beat + offset}`);
        return chordId(parseChordSymbol(e.chord, key.tonic));
      };
      const chords: string[] = [];
      for (let s = 0; s < SLOTS; s++) {
        chords.push(beatChord(s * SLOT_BEATS));
        for (let k = 1; k < SLOT_BEATS; k++) if (beatChord(s * SLOT_BEATS + k) !== chords[s]) offGridChordChanges++;
      }
      let mid = 0;
      for (let bar = 0; bar < BARS; bar++) if (chords[bar * SLOTS_PER_BAR] !== chords[bar * SLOTS_PER_BAR + 1]) mid++;
      items.push({
        id, bank, name,
        family: bank === 'stefan' ? stefanBatch.get(name)! : `song:${normName(name)}`,
        group: bank === 'stefan' ? 'stefan' : 'songs',
        tonicPc: key.tonic,
        tempo: Number(props.tempo),
        notes,
        chords,
        midBarChanges: mid,
      });
    }
  }
  return { items, report: { dropped, pickupNotesDropped, offGridChordChanges } };
}

function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

/** Hold out `frac` of the families of each group (songs, stefan), chosen by a salted hash. */
export function splitByFamily(items: readonly Item[], frac: number, salt: string): { train: Item[]; test: Item[] } {
  const test = new Set<string>();
  for (const group of ['songs', 'stefan'] as const) {
    const fams = [...new Set(items.filter((i) => i.group === group).map((i) => i.family))].sort((a, b) => fnv(salt + a) - fnv(salt + b));
    fams.slice(0, Math.round(fams.length * frac)).forEach((f) => test.add(f));
  }
  return { train: items.filter((i) => !test.has(i.family)), test: items.filter((i) => test.has(i.family)) };
}

export interface BankProgression extends KnownProgression {
  readonly normName: string;
  readonly roles: readonly string[];
}

/** The 79-entry chord bank, each 4-bar entry looped to 8 bars, chords at the half-bar grid, relative to C. */
export function loadBankProgressions(): BankProgression[] {
  const C = parseKey('C');
  const tonic = parsePc('C');
  return loadChordBank().map((e, i) => {
    const bars = resolveBankEntry(e, C);
    if (bars.length !== 4) throw new Error(`bank entry ${e.precedent}: ${bars.length} bars, expected 4`);
    const four: string[] = [];
    for (const bar of bars) {
      if (bar.length !== 4) throw new Error(`bank entry ${e.precedent}: bar with ${bar.length} beats`);
      four.push(chordId(parseChordSymbol(bar[0]!, tonic)), chordId(parseChordSymbol(bar[2]!, tonic)));
    }
    return { name: `${e.precedent} #${i}`, normName: normName(e.precedent), roles: e.roles, slots: [...four, ...four] };
  });
}
