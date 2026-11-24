// Arrangement clashes (owner's design, 2026-11-24): after the patterns are generated, parts that get in each other's
// way are adjusted, measured from the notes themselves (no rules per instrument pair).
//
// Per section, over the non-drum, non-vocal parts that are not sustained (a pad holding chords is not in anyone's
// way):
//   1. Competition: two or more busy parts (busyPerBar onsets a bar or more), whatever their register (a wild bass
//      under wild strings): the highest-priority busy part keeps its pattern, the others are calmed.
//   2. Clash: two dense parts (densePerBar or more) in the same register band whose onsets mostly coincide (unison:
//      the share of the sparser part's onsets landing with the other's) — rhythmic unison in one range is mush. The
//      lower-priority part is moulded around the other: where the other strikes, it holds its previous note instead
//      (the downbeat of each bar always stays). If that would take away more than maxMouldRemoval of its notes it is
//      calmed instead.
//   Left alone: interplay (dense parts whose onsets interleave), doubling (parts of one family: Guitar + Guitar 2),
//   and parts that cannot be moulded note by note (guitar patterns and strums), which then keep priority. Tracks the
//   user edited (trackEdits) are left as written: orchestrate resolves clashes on the song without the edits.
//
// Calming keeps a part's notes on the beat (whole beats), each held until the next kept note: the same part, calmer.
// Register bands are by family (bass low; keys, pad, guitar, strings, brass middle; synths high): chord-relative
// events carry no pitch of their own. Priority (who keeps the pattern): bass, guitar, keys, pad, synths, plucked
// synths, strings, brass. Deterministic: no random draws.

import { formatBarBeat, parseBarBeat } from '@casperaki/music-theory';

import type { BarPattern, FamilyPattern, PatternResult } from '../patterns/types.js';

/** The thresholds, in one place to tune by ear. */
export const CLASH_RULES = {
  /** Onsets a bar from which a part is busy (competition). */
  busyPerBar: 8,
  /** Onsets a bar from which a part is dense (clash). */
  densePerBar: 6,
  /** Share of the sparser part's onsets landing with the other's that makes a clash. */
  unison: 0.6,
  /** Moulding that would take away more than this share of a part's notes calms it instead. */
  maxMouldRemoval: 0.5,
  /** A part whose notes last this many beats on average and that plays fewer than sustainedMaxPerBar onsets a bar
   *  is sustained (left alone). */
  sustainedMeanBeats: 2,
  sustainedMaxPerBar: 3,
} as const;

const PRIORITY = ['Bass', 'Guitar', 'Keys', 'Pad', 'Synths', 'PluckedSynths', 'PopStrings', 'PopBrass'];
const BAND: Readonly<Record<string, 'low' | 'mid' | 'high'>> = {
  Bass: 'low',
  Keys: 'mid',
  Pad: 'mid',
  Guitar: 'mid',
  PopStrings: 'mid',
  PopBrass: 'mid',
  Synths: 'high',
  PluckedSynths: 'high',
};
/** Events that hold several notes inside (patterns, strums, arpeggiators): not mouldable note by note. */
const UNMOULDABLE = new Set(['virtualGuitarist', 'strum', 'EDMArpeggiator', 'arpeggio', 'fretNoise']);
const BEATS_PER_BAR = 4;

const familyOf = (lane: string) => lane.replace(/ \d+$/u, '');
const priorityOf = (lane: string) => {
  const i = PRIORITY.indexOf(familyOf(lane));
  return i < 0 ? PRIORITY.length : i;
};

interface Part {
  readonly lane: string;
  readonly family: string;
  readonly band: 'low' | 'mid' | 'high' | undefined;
  /** Onsets per bar, as 16th-note slots (bar * 16 + slot). */
  readonly onsets: Set<number>;
  readonly perBar: number;
  readonly sustained: boolean;
  /** Can be moulded note by note. */
  readonly mouldable: boolean;
}

function describe(lane: string, pattern: FamilyPattern): Part | undefined {
  const family = familyOf(lane);
  if (family === 'Drums' || /vocal/iu.test(lane)) return undefined;
  const onsets = new Set<number>();
  let mouldable = true;
  pattern.bars.forEach((bar, b) => {
    for (const [beat, evs] of Object.entries(bar.notes)) {
      if (!evs?.length) continue;
      onsets.add(b * 16 + Math.round(parseBarBeat(beat) * 4));
      for (const e of evs) {
        if (UNMOULDABLE.has((e as { type?: string }).type ?? '')) mouldable = false;
      }
    }
  });
  if (onsets.size === 0) return undefined;
  const perBar = onsets.size / pattern.bars.length;
  return { lane, family, band: BAND[family], onsets, perBar, sustained: isSustained(pattern), mouldable };
}

/** A part that holds its notes (a pad holding chords): long notes on average, few onsets a bar. */
export function isSustained(pattern: FamilyPattern): boolean {
  let onsets = 0;
  let events = 0;
  let totalLength = 0;
  for (const bar of pattern.bars) {
    for (const evs of Object.values(bar.notes)) {
      if (!evs?.length) continue;
      onsets++;
      for (const e of evs) {
        events++;
        totalLength += (e as { duration?: number }).duration ?? 0;
      }
    }
  }
  const perBar = onsets / Math.max(1, pattern.bars.length);
  return totalLength / Math.max(1, events) >= CLASH_RULES.sustainedMeanBeats && perBar < CLASH_RULES.sustainedMaxPerBar;
}

/** Keeps a bar's events at the given beats, each kept event held until the next kept beat (or its own end if later,
 *  never past the bar). */
function keepAndHold(bar: BarPattern, keep: (beat: number) => boolean): BarPattern {
  const beats = Object.keys(bar.notes).map((k) => ({ key: k, beat: parseBarBeat(k) })).sort((a, b) => a.beat - b.beat);
  const kept = beats.filter((x) => keep(x.beat));
  const notes: BarPattern['notes'] = {};
  kept.forEach((x, i) => {
    const nextBeat = kept[i + 1]?.beat ?? BEATS_PER_BAR;
    notes[formatBarBeat(x.beat) as keyof BarPattern['notes']] = bar.notes[x.key as keyof BarPattern['notes']]!.map((e) => {
      const ev = e as { duration?: number };
      if (ev.duration === undefined) return e;
      return { ...e, duration: Math.min(BEATS_PER_BAR - x.beat, Math.max(ev.duration, nextBeat - x.beat)) } as typeof e;
    });
  });
  return { notes };
}

/** The same part, calmer: only its notes on whole beats, each held to the next. */
function calm(pattern: FamilyPattern): FamilyPattern {
  return { bars: pattern.bars.map((bar) => keepAndHold(bar, (beat) => Number.isInteger(beat))) };
}

/** The part moulded around `main`: where main strikes (except each bar's downbeat) it holds instead of striking.
 *  Undefined when that would take away more than maxMouldRemoval of its notes. */
function mould(pattern: FamilyPattern, main: Part): FamilyPattern | undefined {
  let before = 0;
  let removed = 0;
  const bars = pattern.bars.map((bar, b) => {
    const keep = (beat: number) => {
      const slot = b * 16 + Math.round(beat * 4);
      return beat === 0 || !main.onsets.has(slot);
    };
    for (const k of Object.keys(bar.notes)) {
      before++;
      if (!keep(parseBarBeat(k))) removed++;
    }
    return keepAndHold(bar, keep);
  });
  return removed / Math.max(1, before) > CLASH_RULES.maxMouldRemoval ? undefined : { bars };
}

/** Which of two parts keeps its pattern: the one that cannot be moulded, else the higher priority (then the name). */
function ranked(a: Part, b: Part): [Part, Part] {
  if (a.mouldable !== b.mouldable) return a.mouldable ? [b, a] : [a, b];
  const pa = priorityOf(a.lane);
  const pb = priorityOf(b.lane);
  if (pa !== pb) return pa < pb ? [a, b] : [b, a];
  return a.lane < b.lane ? [a, b] : [b, a];
}

export function resolveArrangementClashes(patterns: PatternResult): PatternResult {
  return {
    segments: patterns.segments.map((segment) => {
      const lanes: Record<string, FamilyPattern> = { ...segment.lanes };
      const describeAll = () =>
        Object.entries(lanes)
          .map(([lane, p]) => describe(lane, p))
          .filter((p): p is Part => p !== undefined && !p.sustained);

      // 1. Competition: one busy part keeps its pattern, the other busy ones calm down (mouldable ones only).
      const busy = describeAll().filter((p) => p.perBar >= CLASH_RULES.busyPerBar);
      if (busy.length >= 2) {
        const keeper = busy.reduce((k, p) => ranked(k, p)[0]);
        for (const p of busy) if (p !== keeper && p.mouldable && p.family !== keeper.family) lanes[p.lane] = calm(lanes[p.lane]!);
      }

      // 2. Clash: same band, both dense, mostly together, different families: mould (or calm) the one that yields.
      const parts = describeAll();
      for (let i = 0; i < parts.length; i++) {
        for (let j = i + 1; j < parts.length; j++) {
          const a = parts[i]!;
          const b = parts[j]!;
          if (a.family === b.family || !a.band || a.band !== b.band) continue;
          if (a.perBar < CLASH_RULES.densePerBar || b.perBar < CLASH_RULES.densePerBar) continue;
          const [few, many] = a.onsets.size <= b.onsets.size ? [a, b] : [b, a];
          const together = [...few.onsets].filter((o) => many.onsets.has(o)).length / few.onsets.size;
          if (together < CLASH_RULES.unison) continue;
          const [main, yields] = ranked(a, b);
          if (!yields.mouldable) continue;
          lanes[yields.lane] = mould(lanes[yields.lane]!, main) ?? calm(lanes[yields.lane]!);
        }
      }
      return { ...segment, lanes };
    }),
  };
}
