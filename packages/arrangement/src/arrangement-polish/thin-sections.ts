// Thin sections (owner's idea, 2026-11-24; docs/superpowers/specs/2026-11-24-thin-sections-design.md): after the
// patterns are written and clashes resolved, a section whose harmony or rhythm is thin gets a partner track of the
// same kind as its thin part (Pad 2, Synths 2, …), with a sound the song does not use yet and its own pattern; then
// clashes and thinness are checked again.
//
// Measured per section, over every part except drums, bass, vocals and the loop (measured from the notes themselves):
//   - Harmony: on each beat, the notes sounding (pitch classes; a chord, strum or guitar pattern counts its chord's
//     notes; a chord-relative note, whose pitch the engine resolves, counts as one). Thin when the median beat has
//     fewer than minVoices.
//   - Rhythm: a gap bar holds a stretch of gapBeats or more beats in which no part starts a note (the bar's start and
//     end are boundaries). Thin when more than maxGapBarShare of the bars are gap bars.
// An event sounds for its duration; one without a duration (strums, guitar patterns) rings until its part's next
// onset in the bar.
//
// The loop (addThinPartners): the first thin section (song order; harmony before rhythm; intros, outros and breaks are
// sparse on purpose and never paired) whose section type and kind were not tried yet gets a partner for its thin
// part: a new lane of the part's family (Pad 2, …), a sound the song does not use yet, playing in every section of
// that type. THIN_RULES.variants pattern options are written for it on
// their own named streams (thin/<lane>#<k>), each through the clash pass; the one that helps the thin section most is
// kept, none if none helps. Then everything is measured again, up to THIN_RULES.maxAddedTracks added tracks.
//
// Deterministic: measuring draws nothing; a partner's sound forks thin/<lane>/sound, its patterns thin/<lane>#<k>.

import { chordNotes, parseBarBeat, parseChord } from '@casperaki/music-theory';

import type { ValidatedCatalogEntry } from '../catalog/validated-catalog.js';
import type { GeneratorContext } from '../context.js';
import type { FamilyPattern, PatternResult } from '../patterns/types.js';
import { LANE_BASE_NAMES } from '../selection/index.js';
import type { InstrumentFamily, SelectionResult } from '../selection/types.js';
import { isSustained } from './clashes.js';
import { segmentType } from './segment-type.js';

/** The thresholds, in one place to tune by ear. */
export const THIN_RULES = {
  /** A section whose median beat has fewer sounding notes than this is harmony-thin. */
  minVoices: 3,
  /** A stretch this many beats long without any onset makes a gap bar. */
  gapBeats: 2,
  /** More than this share of gap bars makes a section rhythm-thin. */
  maxGapBarShare: 0.25,
  /** Pattern options written for a partner track; the one that fills best is kept. */
  variants: 4,
  /** Partner tracks added to one song at most. */
  maxAddedTracks: 2,
} as const;

export type ThinKind = 'harmony' | 'rhythm';

export interface SectionThinness {
  readonly harmony: boolean;
  readonly rhythm: boolean;
  readonly medianVoices: number;
  readonly gapBars: number;
}

const BEATS_PER_BAR = 4;
const CHORD_EVENTS = new Set(['chord', 'strum', 'virtualGuitarist', 'arpeggio', 'EDMArpeggiator']);

/** Lanes the measure covers: not drums, bass, vocals or the loop. */
export function isMeasured(lane: string): boolean {
  const family = lane.replace(/ \d+$/u, '');
  return family !== 'Drums' && family !== 'Bass' && family !== 'Loop' && !/vocal/iu.test(lane);
}

interface Sounding {
  readonly start: number;
  readonly end: number;
  /** Known pitch classes. */
  readonly pcs: readonly number[];
  /** Notes whose pitch the engine resolves (chord-relative). */
  readonly unknown: number;
}

/** One bar of one lane as sounding spans (beats within the bar). */
function soundingIn(bar: FamilyPattern['bars'][number]): Sounding[] {
  const onsets = Object.entries(bar.notes)
    .filter(([, evs]) => evs?.length)
    .map(([k, evs]) => ({ beat: parseBarBeat(k), evs: evs! }))
    .sort((a, b) => a.beat - b.beat);
  const out: Sounding[] = [];
  onsets.forEach(({ beat, evs }, i) => {
    const next = onsets[i + 1]?.beat ?? BEATS_PER_BAR;
    for (const e of evs) {
      const ev = e as { type?: string; duration?: number; note?: number; chord?: string };
      const end = typeof ev.duration === 'number' ? Math.min(BEATS_PER_BAR, beat + ev.duration) : next;
      if (ev.type === 'note' && typeof ev.note === 'number') {
        out.push({ start: beat, end, pcs: [ev.note % 12], unknown: 0 });
      } else if (ev.type !== undefined && CHORD_EVENTS.has(ev.type) && typeof ev.chord === 'string') {
        out.push({ start: beat, end, pcs: chordNotes(parseChord(ev.chord)).map((n) => n % 12), unknown: 0 });
      } else if (ev.type === 'noteRelative') {
        out.push({ start: beat, end, pcs: [], unknown: 1 });
      } else if (ev.type === 'fretNoise') {
        out.push({ start: beat, end, pcs: [], unknown: 0 });
      } else {
        throw new Error(`thin-sections: cannot measure event ${JSON.stringify(e)}`);
      }
    }
  });
  return out;
}

function measuredLanes(lanes: Readonly<Record<string, FamilyPattern>>): [string, FamilyPattern][] {
  return Object.entries(lanes).filter(([lane]) => isMeasured(lane));
}

function barCount(lanes: readonly [string, FamilyPattern][]): number {
  return Math.max(0, ...lanes.map(([, p]) => p.bars.length));
}

/** Gap bars of the given lanes: bars with a stretch of gapBeats or more without any onset. */
function gapBarsOf(lanes: readonly FamilyPattern[], bars: number): number {
  let gaps = 0;
  for (let b = 0; b < bars; b++) {
    const onsets = new Set<number>();
    for (const p of lanes) {
      for (const [k, evs] of Object.entries(p.bars[b]?.notes ?? {})) if (evs?.length) onsets.add(parseBarBeat(k));
    }
    const points = [0, ...[...onsets].sort((x, y) => x - y), BEATS_PER_BAR];
    if (points.some((p, i) => i > 0 && p - points[i - 1]! >= THIN_RULES.gapBeats)) gaps++;
  }
  return gaps;
}

export function measureSection(lanes: Readonly<Record<string, FamilyPattern>>): SectionThinness {
  const measured = measuredLanes(lanes);
  const bars = Math.max(1, barCount(measured));
  const voices: number[] = [];
  for (let b = 0; b < bars; b++) {
    const spans = measured.flatMap(([, p]) => (p.bars[b] ? soundingIn(p.bars[b]!) : []));
    for (let beat = 0; beat < BEATS_PER_BAR; beat++) {
      const pcs = new Set<number>();
      let unknown = 0;
      for (const s of spans) {
        if (s.start <= beat && beat < s.end) {
          s.pcs.forEach((pc) => pcs.add(pc));
          unknown += s.unknown;
        }
      }
      voices.push(pcs.size + unknown);
    }
  }
  voices.sort((a, b) => a - b);
  const medianVoices = voices[Math.floor(voices.length / 2)]!;
  const gapBars = gapBarsOf(measured.map(([, p]) => p), bars);
  return {
    harmony: medianVoices < THIN_RULES.minVoices,
    rhythm: gapBars / bars > THIN_RULES.maxGapBarShare,
    medianVoices,
    gapBars,
  };
}

/** Beats a lane sounds over the section. */
function soundingTime(p: FamilyPattern): number {
  return p.bars.reduce((t, bar) => t + soundingIn(bar).reduce((u, s) => u + (s.end - s.start), 0), 0);
}

/** The part a thin section's partner track pairs with: for harmony the pad (else the part sounding longest), for
 *  rhythm the moving part with the most gap bars of its own. Undefined when there is none. */
export function partnerLane(lanes: Readonly<Record<string, FamilyPattern>>, kind: ThinKind): string | undefined {
  const measured = measuredLanes(lanes);
  const best = (cands: [string, FamilyPattern][], score: (p: FamilyPattern) => number) => {
    let pick: [string, number] | undefined;
    for (const [lane, p] of cands) {
      const s = score(p);
      if (s > 0 && (!pick || s > pick[1])) pick = [lane, s];
    }
    return pick?.[0];
  };
  if (kind === 'harmony') {
    const pads = measured.filter(([lane]) => lane.replace(/ \d+$/u, '') === 'Pad');
    return best(pads, soundingTime) ?? best(measured, soundingTime);
  }
  const moving = measured.filter(([, p]) => !isSustained(p));
  return best(moving, (p) => gapBarsOf([p], p.bars.length));
}

/** How much a partner track helps a thin section: (thin kinds cleared, gap bars removed, median notes gained),
 *  compared in that order. */
export function fillScore(before: SectionThinness, after: SectionThinness): readonly [number, number, number] {
  const cleared = (before.harmony && !after.harmony ? 1 : 0) + (before.rhythm && !after.rhythm ? 1 : 0);
  return [cleared, before.gapBars - after.gapBars, after.medianVoices - before.medianVoices];
}

export interface AddedPartner {
  readonly lane: string;
  readonly family: InstrumentFamily;
  readonly soundId: string;
  readonly sectionType: string;
  readonly kind: ThinKind;
  readonly fork: string;
}

export interface ThinPartnerInput {
  readonly ctx: GeneratorContext;
  readonly selection: SelectionResult;
  /** Writes and clash-resolves the whole song for a selection and its named lane streams. */
  readonly write: (selection: SelectionResult, laneForks: ReadonlyMap<string, string>) => PatternResult;
  /** The sounds a lane of the family may use in the song's genre. */
  readonly soundPool: (family: InstrumentFamily) => readonly ValidatedCatalogEntry[];
  /** Lane names a partner may not take (tracks the user added by edits). */
  readonly reservedNames: ReadonlySet<string>;
}

export interface ThinPartnerResult {
  readonly selection: SelectionResult;
  readonly laneForks: Map<string, string>;
  readonly patterns: PatternResult;
  readonly added: AddedPartner[];
}

const better = (a: readonly number[], b: readonly number[]) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
};
const NOTHING = [0, 0, 0] as const;
/** Section types that are sparse on purpose (they build up or drop out): never paired. */
const SPARSE_ON_PURPOSE = new Set(['intro', 'outro', 'break']);

export function addThinPartners(input: ThinPartnerInput): ThinPartnerResult {
  const { ctx, write, soundPool, reservedNames } = input;
  let selection = input.selection;
  let laneForks = new Map<string, string>();
  let patterns = write(selection, laneForks);
  const added: AddedPartner[] = [];
  const tried = new Set<string>();

  while (added.length < THIN_RULES.maxAddedTracks) {
    const target = firstThin(patterns, tried);
    if (!target) break;
    tried.add(`${target.type}:${target.kind}`);
    const lanes = patterns.segments[target.index]!.lanes;
    const partner = partnerLane(lanes, target.kind);
    if (!partner) continue;
    const partnerInst = selection.instruments.find((i) => i.lane === partner);
    if (!partnerInst) throw new Error(`thin-sections: lane "${partner}" plays in "${target.segmentName}" but is not in the selection`);
    const family = partnerInst.family;
    const used = new Set(selection.instruments.map((i) => i.entry.id));
    const unused = soundPool(family).filter((e) => !used.has(e.id));
    if (unused.length === 0) continue;
    // Sounds tagged with the song's genre first. Several families have none for some genres (urban keys): then the
    // family's any-genre pool, recorded as a fallback pick exactly as selection records its own.
    const genre = ctx.params.genre;
    const tagged = unused.filter((e) => e.mainStyle === genre || (e.addStyles as readonly string[]).includes(genre));
    const pickSource = tagged.length > 0 ? ('genre' as const) : ('fallback' as const);

    const taken = new Set([...selection.instruments.map((i) => i.lane), ...reservedNames]);
    const lane = freeName(family, taken);
    const entry = ctx.rng.fork(`thin/${lane}/sound`).pick(tagged.length > 0 ? tagged : unused);
    const candidate: SelectionResult = {
      ...selection,
      instruments: [
        ...selection.instruments,
        { lane, family, lowLevel: entry.lowLevel, entry, essential: false, perSegment: true, pickSource },
      ],
      segments: selection.segments.map((seg) =>
        segmentType(seg.segmentName) === target.type ? { ...seg, activeLanes: [...seg.activeLanes, lane] } : seg,
      ),
    };

    const before = measureSection(lanes);
    let best: { score: readonly number[]; forks: Map<string, string>; patterns: PatternResult; fork: string } | undefined;
    for (let k = 1; k <= THIN_RULES.variants; k++) {
      const fork = `thin/${lane}#${k}`;
      const forks = new Map(laneForks).set(lane, fork);
      const written = write(candidate, forks);
      const score = fillScore(before, measureSection(written.segments[target.index]!.lanes));
      if (!best || better(score, best.score)) best = { score, forks, patterns: written, fork };
    }
    if (!best || !better(best.score, NOTHING)) continue;

    selection = candidate;
    laneForks = best.forks;
    patterns = best.patterns;
    added.push({ lane, family, soundId: entry.id, sectionType: target.type, kind: target.kind, fork: best.fork });
  }
  return { selection, laneForks, patterns, added };
}

/** The first thin section (song order; harmony before rhythm) whose type and kind were not tried yet. */
function firstThin(
  patterns: PatternResult,
  tried: ReadonlySet<string>,
): { index: number; segmentName: string; type: string; kind: ThinKind } | undefined {
  for (let index = 0; index < patterns.segments.length; index++) {
    const seg = patterns.segments[index]!;
    const type = segmentType(seg.segmentName);
    if (SPARSE_ON_PURPOSE.has(type)) continue;
    const m = measureSection(seg.lanes);
    for (const kind of ['harmony', 'rhythm'] as const) {
      if (m[kind] && !tried.has(`${type}:${kind}`)) return { index, segmentName: seg.segmentName, type, kind };
    }
  }
  return undefined;
}

function freeName(family: InstrumentFamily, taken: ReadonlySet<string>): string {
  const base = LANE_BASE_NAMES[family];
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
}
