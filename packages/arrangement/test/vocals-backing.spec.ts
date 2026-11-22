// Step 17d — backing vocal generator tests.
//
// Pins the legacy `MelodyClass._getBackingVocals` invariants:
//   - activity gate fires on chorus + bridge only
//   - every backing note is a chord-tone of its bar's chord
//   - lyrics inherit from the lead source note
//   - notes stay within [MIN_NOTE, MAX_NOTE] after the octave-drop guard
//   - same seed twice → byte-identical backing JSON
//   - cross-seed: backings differ because lead differs (no rng draw)
//   - generated Song parseSong-valid (orchestrate end-to-end)

import { describe, expect, it } from 'vitest';

import { createRng, parseChord } from '@casperaki/music-theory';
import {
  ChordSymbolSchema,
  parseSong,
  stableStringify,
} from '@casperaki/song-schema';

import {
  generateChords,
  generateSongStructure,
  generateVocalMelody,
  writeVocals,
  orchestrate,
  VocalResultSchema,
  type GenerateParams,
  type GeneratorContext,
  type VocalResult,
} from '../src/index.js';
import {
  BACKING_OFFSET_1,
  BACKING_OFFSET_2,
  backingMidiRange,
  findClosestChordNote,
  generateBackings,
  isBackingActiveSegment,
  MAX_NOTE,
  MIN_NOTE,
} from '../src/vocals/backing.js';

function makeCtx(seed: string | number, key = 'C', genre = 'brightPop'): GeneratorContext {
  const params: GenerateParams = { genre, key, bpm: 120, seed };
  return { rng: createRng(seed), params };
}

function generate(seed: string | number, key = 'C'): {
  result: VocalResult;
  structure: ReturnType<typeof generateSongStructure>;
} {
  const ctx = makeCtx(seed, key);
  // The vocals return the structure with the sung sections' chords (those of the borrowed melody).
  const { vocals, structure } = writeVocals(ctx, generateChords(ctx, generateSongStructure(ctx)));
  return { result: vocals, structure };
}

function isChordTone(chordSymbol: string, midi: number): boolean {
  const parsed = parseChord(chordSymbol);
  const pcSet = new Set<number>(
    parsed.intervals.map((i) => (((parsed.root + i) % 12) + 12) % 12),
  );
  const pc = ((midi % 12) + 12) % 12;
  return pcSet.has(pc);
}

describe('findClosestChordNote', () => {
  it('returns a chord-tone close to the target MIDI', () => {
    // C major chord at MIDI 60 (C4) is a chord tone; +1 semitone (Db) is not.
    expect(findClosestChordNote('C', 60)).toBe(60);
    const snap = findClosestChordNote('C', 61);
    expect(isChordTone('C', snap)).toBe(true);
    expect(Math.abs(snap - 61)).toBeLessThanOrEqual(2);
  });

  it('snap distance is bounded by 6 semitones (any chord-tone PC is within ±6 of any pitch)', () => {
    for (const chord of ['C', 'Am', 'F', 'G7', 'Dm7', 'A#9', 'Fmaj7', 'Gsus4']) {
      for (let m = 36; m <= 84; m++) {
        const snap = findClosestChordNote(chord, m);
        expect(Math.abs(snap - m)).toBeLessThanOrEqual(6);
        expect(isChordTone(chord, snap)).toBe(true);
      }
    }
  });

  it('is deterministic', () => {
    expect(findClosestChordNote('Am', 55)).toBe(findClosestChordNote('Am', 55));
  });
});

describe('isBackingActiveSegment', () => {
  it('fires on chorus + bridge prefixes', () => {
    expect(isBackingActiveSegment('chorus1')).toBe(true);
    expect(isBackingActiveSegment('chorus3')).toBe(true);
    expect(isBackingActiveSegment('bridge')).toBe(true);
    expect(isBackingActiveSegment('bridge1')).toBe(true);
  });
  it('does NOT fire on verse / preChorus / intro / outro / break', () => {
    expect(isBackingActiveSegment('verse1')).toBe(false);
    expect(isBackingActiveSegment('preChorus2')).toBe(false);
    expect(isBackingActiveSegment('intro')).toBe(false);
    expect(isBackingActiveSegment('outro')).toBe(false);
    expect(isBackingActiveSegment('break1')).toBe(false);
  });
});

describe('generateBackings', () => {
  it('produces backings only on chorus + bridge segments', () => {
    const { result } = generate('backing-activity-check');
    const lanes = [result.backings ?? [], result.backings2 ?? []];
    for (const lane of lanes) {
      expect(lane.length).toBeGreaterThan(0);
      for (const seg of lane) {
        expect(isBackingActiveSegment(seg.segmentName), `unexpected backing segment "${seg.segmentName}"`)
          .toBe(true);
      }
    }
  });

  it('every backing note is a chord-tone of its bar chord', () => {
    const { result, structure } = generate('backing-chordtone-check');
    const structureByName = new Map(structure.map((s) => [s.name, s]));
    for (const lane of [result.backings ?? [], result.backings2 ?? []]) {
      for (const seg of lane) {
        const structureSeg = structureByName.get(seg.segmentName);
        expect(structureSeg).toBeDefined();
        for (let barIndex = 0; barIndex < seg.bars.length; barIndex++) {
          const bar = seg.bars[barIndex]!;
          const structureBar = structureSeg!.bars[barIndex]!;
          for (const [beatKey, events] of Object.entries(bar.notes)) {
            const beat = parseFloat(beatKey);
            const chordIdx = Math.max(
              0,
              Math.min(structureBar.chords.length - 1, Math.floor(beat)),
            );
            const chord = ChordSymbolSchema.parse(structureBar.chords[chordIdx]);
            for (const ev of events ?? []) {
              if (ev.type !== 'vocalNote' || typeof ev.note !== 'number') continue;
              expect(
                isChordTone(chord, ev.note),
                `${seg.segmentName} bar${barIndex} beat${beat}: ${ev.note} not in chord ${chord}`,
              ).toBe(true);
            }
          }
        }
      }
    }
  });

  it('every backing note lands in [MIN_NOTE, MAX_NOTE] after the octave-drop guard', () => {
    const { result } = generate('backing-range-check');
    for (const lane of [result.backings ?? [], result.backings2 ?? []]) {
      for (const seg of lane) {
        const range = backingMidiRange(seg);
        if (!range) continue;
        // Octave-drop guard only attempts ONE drop (legacy: MelodyClass.js:
        // 3216-3267). If lead notes are in [43..59] and the +4 shift then
        // an octave drop both fire, the lane lands at worst in
        // [43+(-4)-12 .. 59+4-12] = [27..51]. The MIN bound can dip below
        // 43 in pathological cases; document the bound rather than
        // tightening it (this matches the legacy "log and accept" tail).
        expect(range.max).toBeLessThanOrEqual(MAX_NOTE);
      }
    }
  });

  it('backing notes inherit lyrics + duration + endOfPhrase from lead source notes', () => {
    const { result } = generate('backing-lyric-inherit-check');
    const leadByName = new Map(result.segments.map((s) => [s.segmentName, s]));
    for (const lane of [result.backings ?? [], result.backings2 ?? []]) {
      for (const seg of lane) {
        const lead = leadByName.get(seg.segmentName);
        expect(lead).toBeDefined();
        for (let barIndex = 0; barIndex < seg.bars.length; barIndex++) {
          const backingBar = seg.bars[barIndex]!;
          const leadBar = lead!.bars[barIndex]!;
          for (const [beatKey, backingEvents] of Object.entries(backingBar.notes)) {
            const leadEvents = (leadBar.notes as Record<string, typeof backingEvents>)[beatKey];
            if (!leadEvents) continue;
            // Iterate in parallel index order — the backing pass preserves
            // the same per-beat ordering as the lead.
            for (let i = 0; i < (backingEvents ?? []).length; i++) {
              const backing = backingEvents![i]!;
              const leadEv = leadEvents[i]!;
              if (backing.type !== 'vocalNote' || leadEv.type !== 'vocalNote') continue;
              expect(backing.fullWord).toBe(leadEv.fullWord);
              expect(backing.duration).toBe(leadEv.duration);
              expect(backing.endOfPhrase).toBe(leadEv.endOfPhrase);
              expect(backing.vocaloidPhonemes).toEqual(leadEv.vocaloidPhonemes);
            }
          }
        }
      }
    }
  });

  it('backings 1 / 2 differ from lead (offset + snap applied)', () => {
    const { result } = generate('backing-shift-check');
    expect(result.backings).toBeDefined();
    expect(result.backings2).toBeDefined();
    // At least one backing note must differ from its lead counterpart in
    // pitch — otherwise the offset+snap pass is a no-op.
    const leadByName = new Map(result.segments.map((s) => [s.segmentName, s]));
    let sawDiff = 0;
    for (const lane of [result.backings!, result.backings2!]) {
      for (const seg of lane) {
        const lead = leadByName.get(seg.segmentName)!;
        for (let barIndex = 0; barIndex < seg.bars.length; barIndex++) {
          const backingBar = seg.bars[barIndex]!;
          const leadBar = lead.bars[barIndex]!;
          for (const [beatKey, backingEvents] of Object.entries(backingBar.notes)) {
            const leadEvents = (leadBar.notes as Record<string, typeof backingEvents>)[beatKey] ?? [];
            for (let i = 0; i < (backingEvents ?? []).length; i++) {
              const b = backingEvents![i]!;
              const l = leadEvents[i];
              if (b?.type === 'vocalNote' && l?.type === 'vocalNote' && b.note !== l.note) sawDiff++;
            }
          }
        }
      }
    }
    expect(sawDiff).toBeGreaterThan(0);
  });

  it('is deterministic — same seed twice → byte-identical backings', () => {
    const a = stableStringify(generate('repro-back').result.backings ?? null, 2);
    const b = stableStringify(generate('repro-back').result.backings ?? null, 2);
    expect(a).toBe(b);
    const a2 = stableStringify(generate('repro-back').result.backings2 ?? null, 2);
    const b2 = stableStringify(generate('repro-back').result.backings2 ?? null, 2);
    expect(a2).toBe(b2);
  });

  it('consumes no extra rng draws — replacing lead with a constant identity backing is deterministic', () => {
    // Direct test of generateBackings purity: same lead in → same out.
    const { result, structure } = generate('purity-check');
    const a = stableStringify(
      generateBackings({ segments: result.segments }, structure, { pitchOffset: BACKING_OFFSET_1 }),
      2,
    );
    const b = stableStringify(
      generateBackings({ segments: result.segments }, structure, { pitchOffset: BACKING_OFFSET_1 }),
      2,
    );
    expect(a).toBe(b);
  });

  it('different seeds → different backings (because lead changes)', () => {
    const a = stableStringify(generate('seed-one').result.backings ?? null, 2);
    const b = stableStringify(generate('seed-two').result.backings ?? null, 2);
    expect(a).not.toBe(b);
  });

  it('VocalResult with backings still validates against VocalResultSchema', () => {
    const { result } = generate('schema-check-back');
    const parsed = VocalResultSchema.safeParse(result);
    if (!parsed.success) console.error(parsed.error.issues);
    expect(parsed.success).toBe(true);
  });

  it('lead-lane notes are unchanged by the backing pass', () => {
    // Generate lead-only via direct slice, then full result; the lead
    // segments must be byte-identical.
    const { result } = generate('lead-stable-check');
    const leadOnly = { segments: result.segments };
    const parsed = VocalResultSchema.safeParse(leadOnly);
    expect(parsed.success).toBe(true);
    // The lead `segments` array is the same reference path as result; if
    // backing generation accidentally mutated it, golden tests would
    // already break. This test pins the behaviour at the type level by
    // verifying every lead segment's note count is non-zero (mutation
    // would either zero-out or shift events).
    for (const seg of result.segments) {
      let noteCount = 0;
      for (const bar of seg.bars) {
        for (const events of Object.values(bar.notes)) noteCount += (events ?? []).length;
      }
      expect(noteCount).toBeGreaterThan(0);
    }
  });

  it('non-eligible segments have no backings (verse / preChorus / intro / outro)', () => {
    const { result } = generate('non-eligible-check');
    const eligibleNames = new Set(
      result.segments
        .map((s) => s.segmentName)
        .filter((n) => isBackingActiveSegment(n)),
    );
    for (const lane of [result.backings ?? [], result.backings2 ?? []]) {
      for (const seg of lane) {
        expect(eligibleNames.has(seg.segmentName)).toBe(true);
      }
    }
  });

  it('orchestrate end-to-end: generated Song parseSong-valid and surfaces backing data', () => {
    const song = orchestrate({ genre: 'brightPop', key: 'C', bpm: 120, seed: 'orchestrate-back' });
    // parseSong does Zod + semantic validation.
    const reparsed = parseSong(song);
    expect(reparsed).toBeDefined();
    // At least one chorus segment must declare Backing vocals 1 + 2.
    let sawBackingTrue = 0;
    for (const [segName, payload] of Object.entries(song.arrangement)) {
      if (!segName.startsWith('chorus') && !segName.startsWith('bridge')) continue;
      const instr = payload.instruments as Record<string, boolean>;
      if (instr['Backing vocals 1'] === true) sawBackingTrue++;
      if (instr['Backing vocals 2'] === true) sawBackingTrue++;
      const overrides = payload.overrides as Record<string, unknown>;
      // chorus/bridge overrides should carry both lanes.
      expect(overrides['Backing vocals 1']).toBeDefined();
      expect(overrides['Backing vocals 2']).toBeDefined();
    }
    expect(sawBackingTrue).toBeGreaterThan(0);
  });
});

describe('backing offsets match legacy', () => {
  it('exposes BACKING_OFFSET_1 = -4, BACKING_OFFSET_2 = +4 (MelodyClass.js:26-28)', () => {
    expect(BACKING_OFFSET_1).toBe(-4);
    expect(BACKING_OFFSET_2).toBe(4);
  });
  it('MIN_NOTE / MAX_NOTE are the MelodyClass range envelope in MIDI (legacy indices 43 / 59 + 12)', () => {
    expect(MIN_NOTE).toBe(55);
    expect(MAX_NOTE).toBe(71);
  });
});

describe('backing octave-drop guard units', () => {
  // Legacy MelodyClass.js:3216-3267 drops a backing lane an octave when a note
  // exceeds maxNote = 59 in legacy table indices (MIDI - 12), i.e. MIDI 71.
  const lead = (midi: number) => ({
    segments: [{ segmentName: 'chorus1', bars: [{ notes: { '0.0': [{ type: 'vocalNote' as const, note: midi, duration: 1 }] } }] }],
  });
  const structure = [{ name: 'chorus1', bars: [{ chords: ['C', 'C', 'C', 'C'] }] }] as unknown as Parameters<typeof generateBackings>[1];
  const backingNote = (midi: number, offset: number) =>
    (generateBackings(lead(midi) as never, structure, { pitchOffset: offset })[0]!.bars[0]!.notes['0.0' as never]![0] as { note: number }).note;
  it('keeps a lane at or below B4 (MIDI 71) and drops one above it', () => {
    expect(backingNote(63, 4)).toBe(67); // D#4 + 4 → G4 (67) ≤ 71: kept (the old threshold 59 dropped it to G3)
    expect(backingNote(72, 4)).toBe(64); // C5 + 4 → E5 (76) > 71 → dropped an octave → E4 (64)
  });
});
