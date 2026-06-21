// docs/54s + 54t + 54v + 54x — Acoustic / electric guitar pattern generator (brightPop subset).
//
// 54s: Two-hit-per-bar chord comp using `type: 'chord'` events with
// the brain's per-bar chord progression. Chord events route through
// the engine's `Guitar.h::TonalInstrument::processSegment` →
// `getChordNotes` → ≤3 per-note multisample voices on the long-notes
// sampler.
//
// 54t: One `type: 'fretNoise'` event per bar at beat 3.875 (1/8
// before the next bar's downbeat). Each event's `sounds[0]` field
// indexes into the engine inst's `fx.fxFretNoise[]` array; the
// engine routes them to the fret-noise sampler. We cycle through the
// 8 prestaged sound indices to spread the texture across bars.
//
// 54v: One `type: 'virtualGuitarist'` chord-strum event per bar at
// beat 2.0 (mid-bar). The legacy `virtualGuitaristPatterns` bank
// emits per-bar mixes of strum + fx events; we collapse to a single
// `chordShortStrumDown` per bar at a deterministic mid-bar position
// to add a clean per-bar strum-sampler onset alongside the
// long-notes chord sustain. The event uses the same chord symbol as
// the bar's beat-2 chord-comp event. `chordPosition` is omitted —
// engine `SequencerUtils.h::getGuitarStrums:607-611` defaults to
// position 1 on a missing field. The strum-sampler routing is the
// same path 54m's render spike proved audible after engine patch 02
// (`apps/engine-spike/patches/02-guitar-strum-soundindex-midi-offset.patch`).
//
// 54x: Per-string strum events from the legacy guitarPatterns.json
// bank (Lane A). The generator picks ONE pattern per segment via
// `ctx.rng.fork('patterns/guitar')`, filtered by genre → marker
// (brightPop → 'Pop' substring, mirroring
// GuitarPatternGeneratorClass.js:73-75). The picked pattern's first
// bar's `type: 'strum'` events are repeated across every bar of the
// segment with `chord` rewritten to the bar's chord at the event's
// beat position. Engine path: SequencerUtils.h::getStrumNotes →
// per-string MIDI from GuitarChord{currentChord}.getLowestPosition()
// (always positions[0].midi — the engine's "always pick first
// position" rule, Chord.h:537-554) → long-notes sampler. No extra
// engine patch required; the per-note multisample pool (9000..9029)
// staged for 54s carries all the per-string MIDI the engine needs.
//
// Layered output (all four lanes coexist — separate engine sampler
// tracks):
//   - Per-note multisample pool: chord events at beats 0.0 and 2.0
//                                + per-string strum events from bank
//   - Strums sampler pool:       chordShortStrumDown at beat 2.0
//   - Fret-noise sampler pool:   fretNoise at beat 3.875
//
// Determinism: forks `ctx.rng.fork('patterns/guitar')` per
// family-salt convention. The fork drives the per-segment pattern
// pick (one pick per segment so a song's segments can carry varied
// strumming feels). Same (seed, genre) → identical sequence of picks
// across segments.

import { ChordSymbolSchema, type Segment } from '@casperaki/song-schema';

import type { GeneratorContext } from '../context.js';
import { selectGuitarPattern, type GuitarBankPattern } from './guitar-bank.js';
import {
  postProcessVirtualGuitaristPattern,
  selectVirtualGuitaristPattern,
  type VirtualGuitaristBankPattern,
} from './virtual-guitarist-bank.js';
import { addNoteEvent, emptyBarPattern } from './shared.js';
import type { BarPattern, FamilyPattern, InstrumentFamily } from './types.js';

const HIT_BEATS: readonly number[] = [0.0, 2.0];
const HIT_DURATION = 2;

// docs/62 A9 — fret-noise events are now read from the chosen bank pattern's
// own author-placed `type:'fretNoise'` rows (multi-slice `sounds` indices into
// the engine inst's `fx.fxFretNoise[]`), replacing the prior synthesized
// one-generic-noise-per-bar placeholder (the old FRET_NOISE_* constants).

// docs/54v — replaced by docs/54y.
//
// 54v emitted a single `chordShortStrumDown` at beat 2.0 per bar.
// 54y supersedes this with the full virtualGuitaristPatterns.json
// bank emission (multi-event-per-bar mix of chordLong/Short Strum
// Up/Down + fx1..fx7 articulation). The constants below are kept
// only because tests reference them; the actual emission is
// bank-driven inside the generator body.
const STRUM_BEAT = 2.0;
const STRUM_DURATION = 0.25;
const STRUM_EVENT_NAME = 'chordShortStrumDown';

interface BankStrumEvent {
  readonly beat: number;
  readonly chord: string;
  readonly strings: readonly number[];
  readonly offset: readonly number[];
  readonly durations: readonly number[];
  readonly velocities: readonly number[];
}

// docs/62 A9 — author-placed fretNoise event from guitarPatterns.json. `sounds`
// is a multi-slice INDEX array into the engine inst's `fx.fxFretNoise[]`; the
// per-event offset/durations/velocities travel with the chosen strum pattern.
interface BankFretNoiseEvent {
  readonly beat: number;
  readonly sounds: readonly number[];
  readonly offset: readonly number[];
  readonly durations: readonly number[];
  readonly velocities: readonly number[];
}

interface BankVirtualGuitaristEvent {
  readonly beat: number;
  readonly event: string;
  readonly duration?: number;
  readonly chordPosition?: string;
}

function extractVirtualGuitaristEventsFromBankPattern(
  pattern: VirtualGuitaristBankPattern,
): BankVirtualGuitaristEvent[] {
  // 54y — Lane B consumes ONLY type:'virtualGuitarist' events from the
  // VG bank. The bank's type:'strum' events are owned by Lane A (54x);
  // the bank's type:'fretNoise' events are owned by 54t. We read bar 0
  // and let the per-bar loop repeat across the segment (VG bank rows
  // are predominantly 1 bar; multi-bar rows wrap modulo bar count).
  const out: BankVirtualGuitaristEvent[] = [];
  for (let barIdx = 0; barIdx < pattern.bars.length; barIdx++) {
    const bar = pattern.bars[barIdx]!;
    for (const [beatKey, events] of Object.entries(bar.notes)) {
      const beat = Number.parseFloat(beatKey);
      if (!Number.isFinite(beat)) continue;
      for (const raw of events) {
        const ev = raw as {
          type?: unknown;
          event?: unknown;
          duration?: unknown;
          chordPosition?: unknown;
        };
        if (ev?.type !== 'virtualGuitarist' || typeof ev.event !== 'string') continue;
        const entry: BankVirtualGuitaristEvent = {
          beat: beat + barIdx * 4, // multi-bar wrap (4 beats/bar)
          event: ev.event,
          ...(typeof ev.duration === 'number' && Number.isFinite(ev.duration)
            ? { duration: ev.duration }
            : {}),
          ...(typeof ev.chordPosition === 'string' && ev.chordPosition.length > 0
            ? { chordPosition: ev.chordPosition }
            : {}),
        };
        out.push(entry);
      }
    }
  }
  return out.sort((a, b) => a.beat - b.beat);
}

function extractStrumEventsFromBankPattern(pattern: GuitarBankPattern): BankStrumEvent[][] {
  // 54x — Lane A consumes ONLY type:'strum' events from the bank.
  // Other event types (virtualGuitarist / fretNoise / etc) that
  // appear in some bank rows are owned by other lanes (54t/54v/Lane B).
  // docs/62 A11 — return strum events grouped BY pattern bar so multi-bar
  // patterns (guitarPatterns.json has 8-bar / 6-bar / 2-bar rows) unfold
  // across the segment instead of being flattened to bar 0. The placement
  // loop wraps `segBarIdx % patternBars.length`, mirroring the engine's
  // `barIndex % bars.size()`. A 1-bar pattern yields one bar → identical
  // placement to the pre-A11 bar-0-only behaviour.
  const out: BankStrumEvent[][] = [];
  for (const bar of pattern.bars) {
    const barEvents: BankStrumEvent[] = [];
    for (const [beatKey, events] of Object.entries(bar.notes)) {
      const beat = Number.parseFloat(beatKey);
      if (!Number.isFinite(beat)) continue;
      for (const raw of events) {
        const ev = raw as {
          type?: unknown;
          chord?: unknown;
          strings?: unknown;
          offset?: unknown;
          durations?: unknown;
          velocities?: unknown;
        };
        if (
          ev?.type !== 'strum' ||
          typeof ev.chord !== 'string' ||
          !Array.isArray(ev.strings) ||
          !Array.isArray(ev.offset) ||
          !Array.isArray(ev.durations) ||
          !Array.isArray(ev.velocities)
        ) {
          continue;
        }
        barEvents.push({
          beat,
          chord: ev.chord,
          strings: (ev.strings as unknown[]).map(Number) as number[],
          offset: (ev.offset as unknown[]).map(Number) as number[],
          durations: (ev.durations as unknown[]).map(Number) as number[],
          velocities: (ev.velocities as unknown[]).map(Number) as number[],
        });
      }
    }
    out.push(barEvents.sort((a, b) => a.beat - b.beat));
  }
  return out;
}

// docs/62 A9 — extract the bank pattern's author-placed `fretNoise` events,
// grouped per pattern bar (same multi-bar wrap as the strums). These carry the
// real multi-slice `sounds` indices + per-event offset/durations/velocities,
// replacing the synthesized one-generic-noise-per-bar placeholder. The engine's
// Guitar.h::getFretNoises consumes the `sounds[]` array directly.
function extractFretNoiseEventsFromBankPattern(pattern: GuitarBankPattern): BankFretNoiseEvent[][] {
  const out: BankFretNoiseEvent[][] = [];
  for (const bar of pattern.bars) {
    const barEvents: BankFretNoiseEvent[] = [];
    for (const [beatKey, events] of Object.entries(bar.notes)) {
      const beat = Number.parseFloat(beatKey);
      if (!Number.isFinite(beat)) continue;
      for (const raw of events) {
        const ev = raw as {
          type?: unknown;
          sounds?: unknown;
          offset?: unknown;
          durations?: unknown;
          velocities?: unknown;
        };
        if (
          ev?.type !== 'fretNoise' ||
          !Array.isArray(ev.sounds) ||
          !Array.isArray(ev.offset) ||
          !Array.isArray(ev.durations) ||
          !Array.isArray(ev.velocities)
        ) {
          continue;
        }
        barEvents.push({
          beat,
          sounds: (ev.sounds as unknown[]).map(Number) as number[],
          offset: (ev.offset as unknown[]).map(Number) as number[],
          durations: (ev.durations as unknown[]).map(Number) as number[],
          velocities: (ev.velocities as unknown[]).map(Number) as number[],
        });
      }
    }
    out.push(barEvents.sort((a, b) => a.beat - b.beat));
  }
  return out;
}

export function generateGuitarPattern(
  ctx: GeneratorContext,
  segment: Segment,
  activity: readonly InstrumentFamily[],
): FamilyPattern | undefined {
  if (!activity.includes('guitar')) return undefined;
  // 54x — fork once and use it to pick a per-segment strum pattern
  // from the legacy guitarPatterns.json bank. Same (seed, genre,
  // segment ordinal) → identical pick.
  const rng = ctx.rng.fork('patterns/guitar');
  const bankSelection = selectGuitarPattern(rng, ctx.params.genre);
  const bankStrumBars = extractStrumEventsFromBankPattern(bankSelection.pattern);
  // docs/62 A9 — the chosen pattern's own author-placed fretNoise events.
  const bankFretNoiseBars = extractFretNoiseEventsFromBankPattern(bankSelection.pattern);

  // 54y — independent fork for the virtualGuitarist pattern bank so
  // Lane A's pick and Lane B's pick + fx-substitution sequence stay
  // orthogonal (changing one doesn't shift the other's PRNG state).
  const vgRng = ctx.rng.fork('patterns/guitar/virtualGuitarist');
  const vgSelection = selectVirtualGuitaristPattern(vgRng, ctx.params.genre, ctx.params.bpm);
  const vgProcessed = postProcessVirtualGuitaristPattern(vgRng, vgSelection.pattern);
  const vgEvents = extractVirtualGuitaristEventsFromBankPattern(vgProcessed);

  const bars: BarPattern[] = segment.bars.map(() => emptyBarPattern());
  for (let segBarIdx = 0; segBarIdx < bars.length; segBarIdx++) {
    const chordsThisBar = segment.bars[segBarIdx]!.chords;
    for (const beat of HIT_BEATS) {
      const chordIdx = Math.floor(beat);
      const symbol = chordsThisBar[chordIdx] ?? chordsThisBar[0];
      if (!symbol) {
        throw new Error(
          `generateGuitarPattern: segment "${segment.name}" bar ${segBarIdx} has no chords`,
        );
      }
      const chord = ChordSymbolSchema.parse(symbol);
      addNoteEvent(bars[segBarIdx]!, beat, {
        type: 'chord',
        chord,
        duration: HIT_DURATION,
      });
    }
    // 54y — multi-event virtualGuitarist emission from the legacy
    // virtualGuitaristPatterns.json bank (replaces 54v's single
    // chordShortStrumDown). Each picked pattern's bar 0 typically
    // carries 4-8 events: a mix of chord-strum types (Long/Short ×
    // Up/Down) plus fx1..fx7 articulations. fx events have no chord
    // (engine matches by `fxName` only); chord-strum events carry the
    // bar's chord at their beat position. The engine handles routing
    // to the right pool entry via Guitar.h:319-322.
    for (const vgEv of vgEvents) {
      const isChordStrum = vgEv.event.indexOf('chord') === 0;
      const chordIdx = Math.floor(vgEv.beat);
      const symbol = chordsThisBar[chordIdx] ?? chordsThisBar[0];
      if (isChordStrum && !symbol) continue;
      // fx events still need SOME chord on the event for the schema's
      // chord field (always required by VirtualGuitaristEventSchema).
      // Engine ignores chord for fx — see Guitar.h:319-323.
      const eventChord = ChordSymbolSchema.parse(symbol ?? 'C');
      addNoteEvent(bars[segBarIdx]!, vgEv.beat, {
        type: 'virtualGuitarist',
        chord: eventChord,
        event: vgEv.event,
        ...(typeof vgEv.duration === 'number' ? { duration: vgEv.duration } : {}),
        ...(typeof vgEv.chordPosition === 'string'
          ? { chordPosition: vgEv.chordPosition }
          : {}),
      });
    }
    // 54x — emit one type:'strum' event per bank strum, with `chord`
    // rewritten to the bar's chord at the event's beat position.
    // The engine ignores the event chord literal for per-string MIDI
    // (it uses currentChord from the bar's chord progression), but
    // we set it for diagnostic clarity. `strings`/`offset`/
    // `durations`/`velocities` pass through verbatim.
    // docs/62 A11 — wrap the multi-bar bank pattern across the segment
    // (segBarIdx % patternBars), mirroring the engine's barIndex wrap.
    const strumBar =
      bankStrumBars.length > 0 ? bankStrumBars[segBarIdx % bankStrumBars.length]! : [];
    for (const bankEv of strumBar) {
      const chordIdx = Math.floor(bankEv.beat);
      const symbol = chordsThisBar[chordIdx] ?? chordsThisBar[0];
      if (!symbol) continue;
      const chord = ChordSymbolSchema.parse(symbol);
      addNoteEvent(bars[segBarIdx]!, bankEv.beat, {
        type: 'strum',
        chord,
        strings: [...bankEv.strings],
        offset: [...bankEv.offset],
        durations: [...bankEv.durations],
        velocities: [...bankEv.velocities],
      });
    }
    // docs/62 A9 — emit the bank pattern's OWN author-placed fretNoise events
    // (multi-slice `sounds` indices + per-event offset/durations/velocities),
    // wrapped across the segment like the strums. `sounds[i]` is an INDEX into
    // the engine inst's `fx.fxFretNoise[]` array (not a MIDI note); the engine's
    // Guitar.h::getFretNoises iterates the array directly. A pattern with no
    // fretNoise events emits none (faithful — legacy never synthesizes one).
    const fretNoiseBar =
      bankFretNoiseBars.length > 0 ? bankFretNoiseBars[segBarIdx % bankFretNoiseBars.length]! : [];
    for (const fnEv of fretNoiseBar) {
      addNoteEvent(bars[segBarIdx]!, fnEv.beat, {
        type: 'fretNoise',
        sounds: [...fnEv.sounds],
        offset: [...fnEv.offset],
        durations: [...fnEv.durations],
        velocities: [...fnEv.velocities],
      });
    }
  }
  return { bars };
}
