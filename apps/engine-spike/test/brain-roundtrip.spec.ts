// Phase 3 step 10 — brain → engine round-trip test.
//
// This test exercises two halves of the proof:
//
// 1. ALWAYS: the JS adapter (`emit-brain-roundtrip.mjs`) runs against
//    the current orchestrator and produces a valid engine-envelope
//    `song.json` + `inst-1.json`. The brain's canonical Song hash is
//    pinned via the orchestrate-step-8 golden.
//
// 2. IF the native engine has been built and the WAV exists at
//    `out/brain-roundtrip/out.wav`: parse it and assert it's non-silent.
//    The native render isn't run by vitest (it needs a built JUCE/
//    Tracktion binary that's not part of the JS workspace), but if the
//    operator has run the documented commands the WAV is checked.
//
// Reproducing manually:
//   cd apps/engine-spike
//   pnpm emit:brain-roundtrip
//   node scripts/prestage-samples.mjs
//   rm -f out/brain-roundtrip/out.wav
//   ./native/build/casperaki_spike_artefacts/Debug/casperaki_spike \
//     "$(pwd)/out/brain-roundtrip" \
//     http://127.0.0.1:8080 \
//     "$(pwd)/out/brain-roundtrip/out.wav"
//   pnpm test
//
// See docs/53i-step10-engine-roundtrip.md for the full sequence.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { canonicalStringifySong, contentHash, parseSong } from '@casperaki/song-schema';

import { analyseWav } from '../scripts/check-wav.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT = resolve(ROOT, 'out/brain-roundtrip');
const ADAPTER = resolve(ROOT, 'scripts/emit-brain-roundtrip.mjs');
const WAV_PATH = resolve(OUT, 'out.wav');

const ADAPTER_PARAMS = {
  genre: 'brightPop',
  key: 'C',
  bpm: 120,
  seed: 'brightPop-vertical-slice',
};

function runAdapter(): void {
  execFileSync(process.execPath, [ADAPTER], { stdio: 'pipe' });
}

describe('brain → engine adapter (always-on)', () => {
  it('runs cleanly and emits the expected artefacts (Drums + Bass + Keys + Pad)', () => {
    runAdapter();
    // After step 14 (docs/53y) the adapter emits inst-3.json (Keys) and
    // inst-4.json (Pad) in addition to step 12's inst-2.json (Bass).
    // inst-1.json (Drums) remains byte-identical to the post-step-10
    // baseline.
    for (const name of [
      'song.json',
      'inst-1.json',
      'inst-2.json',
      'inst-3.json',
      'inst-4.json',
      'brain-song.json',
      'brain-hash.txt',
      // Added by docs/54h — per-family resolver verdicts written as
      // sidecar metadata so the prestage script can bridge Bass to
      // real catalog samples without re-running the resolver.
      'asset-manifest.json',
    ]) {
      expect(existsSync(resolve(OUT, name)), `missing ${name}`).toBe(true);
    }
  });

  it('asset-manifest.json records the brain-selected Bass catalog row as resolved', () => {
    runAdapter();
    const manifest = JSON.parse(
      readFileSync(resolve(OUT, 'asset-manifest.json'), 'utf-8'),
    ) as {
      brainHash: string;
      Bass: { status: string; matchKind?: string; relativePath?: string; entryId?: string };
      Keys: { status: string };
      Pad: { status: string };
    };
    // Per docs/54j Stage 2, the manifest now also carries a `Drums`
    // block with per-lane resolver verdicts (one per engine drum role
    // mapped to a component family — kickDrums / snareDrums /
    // hiHatsClosed / hiHatsOpen / cymbals / toms / shakers / clapsSnaps).
    expect(manifest.brainHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(manifest.Bass.status).toBe('resolved');
    expect(manifest.Bass.entryId).toBe('b1a76948693cbc65');
    expect(manifest.Bass.matchKind).toBe('canonical');
    expect(manifest.Bass.relativePath).toContain('BA Trancy Bass');
    expect(manifest.Bass.relativePath).toMatch(/\.mp3$/u);
  });

  it('asset-manifest.json#Bass/Keys/Pad carry per-slot multisample plans (docs/54l)', () => {
    runAdapter();
    const manifest = JSON.parse(
      readFileSync(resolve(OUT, 'asset-manifest.json'), 'utf-8'),
    ) as {
      Bass: { family: string; multisample?: { timingName: string; resolvedCount: number; total: number; slots: Array<{ status: string }> } };
      Keys: { family: string; multisample?: { timingName: string; resolvedCount: number; total: number } };
      Pad:  { family: string; multisample?: { timingName: string; resolvedCount: number; total: number } };
    };
    // Each family's manifest entry now carries the catalog family that drove resolver lookup.
    expect(manifest.Bass.family).toBe('basses');
    expect(manifest.Keys.family).toBe('keys');
    expect(manifest.Pad.family).toBe('popStrings');
    // And the per-slot multisample plan — timing name + resolved counts.
    expect(manifest.Bass.multisample?.timingName).toBe('bassNotes');
    expect(manifest.Bass.multisample?.total).toBe(16);
    expect(manifest.Bass.multisample?.resolvedCount).toBe(16);
    expect(manifest.Keys.multisample?.timingName).toBe('pianoNotes');
    expect(manifest.Keys.multisample?.total).toBe(17);
    expect(manifest.Keys.multisample?.resolvedCount).toBe(17);
    expect(manifest.Pad.multisample?.timingName).toBe('padAndSynthNotes');
    expect(manifest.Pad.multisample?.total).toBe(17);
    expect(manifest.Pad.multisample?.resolvedCount).toBe(17);
  });

  it('asset-manifest.json#Drums carries per-lane resolutions for every engine drum role', () => {
    runAdapter();
    const manifest = JSON.parse(
      readFileSync(resolve(OUT, 'asset-manifest.json'), 'utf-8'),
    ) as {
      Drums?: {
        laneFamilyMap?: Record<string, string>;
        lanes?: Record<
          string,
          { status: string; family?: string; relativePath?: string; entryId?: string }
        >;
      };
    };
    expect(manifest.Drums).toBeDefined();
    expect(manifest.Drums!.laneFamilyMap?.bassDrum1).toBe('kickDrums');
    expect(manifest.Drums!.laneFamilyMap?.snareDrum1).toBe('snareDrums');
    expect(manifest.Drums!.laneFamilyMap?.hiHatClosed1).toBe('hiHatsClosed');
    expect(manifest.Drums!.laneFamilyMap?.hiHatOpen).toBe('hiHatsOpen');
    // Pin the brightPop-vertical-slice seed's expected resolutions —
    // every lane finds a validated catalog row.
    const lanes = manifest.Drums!.lanes!;
    expect(lanes.bassDrum1?.status).toBe('resolved');
    expect(lanes.snareDrum1?.status).toBe('resolved');
    expect(lanes.hiHatClosed1?.status).toBe('resolved');
    expect(lanes.hiHatOpen?.status).toBe('resolved');
  });

  it('the brain Song the adapter emitted is parseSong-valid and hash-stable', () => {
    runAdapter();
    const brainSongRaw = readFileSync(resolve(OUT, 'brain-song.json'), 'utf-8');
    const song = parseSong(JSON.parse(brainSongRaw));
    const hash = contentHash(song);
    const storedHash = readFileSync(resolve(OUT, 'brain-hash.txt'), 'utf-8').trim();
    expect(hash).toBe(storedHash);
    // Same hash a second time confirms canonicalStringifySong + adapter
    // are both deterministic for the slice case.
    const secondHash = contentHash(parseSong(JSON.parse(canonicalStringifySong(song)))); // round-trip
    expect(secondHash).toBe(storedHash);
  });

  it('the engine-envelope song.json carries brain values (tempo/key/genre) + brain chord progression', () => {
    runAdapter();
    const engineSong = JSON.parse(readFileSync(resolve(OUT, 'song.json'), 'utf-8')) as {
      tempo: number;
      key: string;
      genre: string;
      structure: Array<{ segment: string; bars: Array<{ chords: string[] }> }>;
      arrangement: Record<
        string,
        {
          instruments?: Record<string, boolean>;
          overrides: Record<string, { pattern?: Record<string, string> }>;
        }
      >;
      brainProvenance?: { hash: string; params: typeof ADAPTER_PARAMS };
    };
    expect(engineSong.tempo).toBe(ADAPTER_PARAMS.bpm);
    expect(engineSong.key).toBe(ADAPTER_PARAMS.key);
    expect(engineSong.genre).toBe(ADAPTER_PARAMS.genre);
    expect(engineSong.brainProvenance?.params).toEqual(ADAPTER_PARAMS);

    // Step 15 (docs/53z): the adapter walks the brain's full songStructure.
    // The brightPop-vertical-slice seed lands the 14-segment Photograph
    // precedent; pin the count + the chorus1 progression contract.
    expect(engineSong.structure.length).toBeGreaterThanOrEqual(10);
    const totalBars = engineSong.structure.reduce((n, s) => n + s.bars.length, 0);
    // The prior single-segment proof slice emitted only 4 bars of chorus1;
    // the full structure must be materially longer.
    expect(totalBars).toBeGreaterThan(50);

    const chorus1 = engineSong.structure.find((s) => s.segment === 'chorus1')!;
    expect(chorus1).toBeDefined();
    for (const bar of chorus1.bars) {
      expect(bar.chords.length).toBe(4); // beatsPerBar()
      for (const c of bar.chords) expect(typeof c === 'string' && c.length > 0).toBe(true);
    }
    // Slice canary: the bank-derived chorus1 progression starts C, Dm, A#9, C.
    expect(chorus1.bars.slice(0, 4).map((b) => b.chords[0])).toEqual(['C', 'Dm', 'A#9', 'C']);

    // Post-53u drum-bank import: brain's chorus1 drum events come from the
    // legacy drLuke pattern bank. The brightPop-vertical-slice blueprint
    // hits bassDrum1 / snareDrum1 on beats 1 + 3 (slots 8 + 24); hiHatOpen
    // (MIDI 46) is in the brain bar but the adapter only grids
    // bassDrum1/snareDrum1/hiHatClosed1 (see docs/53t + 53u).
    const pattern = engineSong.arrangement.chorus1.overrides.Drums.pattern!;
    expect(pattern.bassDrum1).toBe('00000000x000000000000000x0000000');
    expect(pattern.snareDrum1).toBe('00000000x000000000000000x0000000');
    expect(pattern.hiHatClosed1).toBe('00000000000000000000000000000000');

    // Per-segment activation: chorus1 has Drums+Bass+Keys+Pad active; outro
    // has Pad-only.
    expect(engineSong.arrangement.chorus1.instruments?.Drums).toBe(true);
    expect(engineSong.arrangement.chorus1.instruments?.Bass).toBe(true);
    expect(engineSong.arrangement.chorus1.instruments?.Keys).toBe(true);
    expect(engineSong.arrangement.chorus1.instruments?.Pad).toBe(true);

    const outro = engineSong.arrangement.outro;
    if (outro) {
      // isInstrumentInSegment defaults to true on missing entries, so each
      // emitted family MUST appear as an explicit false to silence it.
      expect(outro.instruments?.Drums).toBeTypeOf('boolean');
      expect(outro.instruments?.Bass).toBeTypeOf('boolean');
      expect(outro.instruments?.Keys).toBeTypeOf('boolean');
      expect(outro.instruments?.Pad).toBeTypeOf('boolean');
    }
  });

  it('the inst-1.json carries the full 17-id Drums kit (engine constructor requirement)', () => {
    runAdapter();
    const inst = JSON.parse(readFileSync(resolve(OUT, 'inst-1.json'), 'utf-8')) as {
      name: string;
      ids: Record<string, number>;
      subInstruments: Record<string, unknown>;
    };
    expect(inst.name).toBe('Drums');
    expect(Object.keys(inst.ids).sort()).toEqual([
      'bassDrum1', 'bassDrum2', 'clap', 'crash1', 'crash2',
      'hiHatClosed1', 'hiHatClosed2', 'hiHatOpen', 'hiHatPedal',
      'ride', 'shaker', 'snap', 'snareDrum1', 'snareDrum2',
      'tom1', 'tom2', 'tom3',
    ]);
    expect(Object.keys(inst.subInstruments).length).toBe(17);
  });

  it('the inst-2.json carries the 16-sample legacy Bass VST kit (engine Bass constructor requirement)', () => {
    runAdapter();
    const inst = JSON.parse(readFileSync(resolve(OUT, 'inst-2.json'), 'utf-8')) as {
      id: number;
      name: string;
      type: string;
      lowLevelType: string;
      samples: Array<{ id: number; note: string; type: 'longNote' | 'shortNote' }>;
    };
    // Engine's Instrument::getType requires the plural "basses" string.
    expect(inst.type).toBe('basses');
    expect(inst.name).toBe('Bass');
    expect(inst.id).toBe(38842);
    expect(inst.samples).toHaveLength(16);
    const long = inst.samples.filter((s) => s.type === 'longNote').length;
    const short = inst.samples.filter((s) => s.type === 'shortNote').length;
    expect(long).toBe(8);
    expect(short).toBe(8);
  });

  it('the inst-3.json and inst-4.json carry the 17-sample Keys/Pad VST kits (Synths constructor requirement)', () => {
    runAdapter();
    const keys = JSON.parse(readFileSync(resolve(OUT, 'inst-3.json'), 'utf-8')) as {
      id: number;
      name: string;
      type: string;
      lowLevelType: string;
      instrumentGroup: string;
      samples: Array<{ id: number; note: string; type: 'longNote' | 'shortNote'; vst: number }>;
    };
    expect(keys.name).toBe('Keys');
    expect(keys.id).toBe(38907);
    // The engine's Instrument::getType maps 'keys' → Type::keys, which the
    // CasperakiEngine dispatch routes to the Synths class (CasperakiEngine.cpp:447).
    expect(keys.type).toBe('keys');
    expect(keys.samples).toHaveLength(17);
    for (const s of keys.samples) expect(s.type).toBe('longNote');

    const pad = JSON.parse(readFileSync(resolve(OUT, 'inst-4.json'), 'utf-8')) as {
      id: number;
      name: string;
      type: string;
      lowLevelType: string;
      instrumentGroup: string;
      samples: Array<{ id: number; note: string; type: 'longNote' | 'shortNote'; vst: number }>;
    };
    expect(pad.name).toBe('Pad');
    expect(pad.id).toBe(38972);
    // Pad uses the 'synths' type so the engine routes it to the Synths class.
    expect(pad.type).toBe('synths');
    expect(pad.samples).toHaveLength(17);
  });

  it('the engine-envelope song.json carries the chord-aware Keys + Pad overrides with chordType voicings (chorus1)', () => {
    runAdapter();
    const engineSong = JSON.parse(readFileSync(resolve(OUT, 'song.json'), 'utf-8')) as {
      arrangement: Record<
        string,
        {
          instruments: Record<string, boolean>;
          overrides: {
            Keys?: {
              type?: string;
              bars?: Array<{
                notes: Record<
                  string,
                  Array<{ type: string; chord?: string; chordType?: string; note?: string; duration: number }>
                >;
              }>;
            };
            Pad?: {
              type?: string;
              bars?: Array<{
                notes: Record<
                  string,
                  Array<{ type: string; chord?: string; chordType?: string; note?: string; duration: number }>
                >;
              }>;
            };
          };
        }
      >;
    };
    const chorus1 = engineSong.arrangement.chorus1!;
    const keys = chorus1.overrides.Keys!;
    expect(keys.type).toBe('brainRoundtrip');
    expect(keys.bars!.length).toBeGreaterThanOrEqual(4);
    // docs/56c follow-on §"EZKeys library import" — brightPop Keys now
    // routes through the legacy `library` (+ `altLibrary`) bank
    // emitting `noteRelative` events instead of the chordsStraight
    // path's `chord` events. The engine path is still
    // `Synths.h` (Instrument.cpp typeTable maps `keys` →
    // Synths.h); noteRelative is the legacy event shape
    // SequencerUtils.h::getRelativeNote already reads
    // (`distanceFromMiddleC` + duration). The first bar's events are
    // checked here — they must carry `noteRelative` + the brain's
    // computed `distanceFromMiddleC` (number) + `chord` (informational
    // string).
    for (const bar of keys.bars!) {
      const beatKey = Object.keys(bar.notes)[0]!;
      const ev = bar.notes[beatKey]![0]!;
      expect(ev.type).toBe('noteRelative');
      // `chord` is informational (engine uses currentChord) but the
      // adapter still passes the field through. Pin it as a string
      // so a future regression that drops it becomes loud.
      expect(typeof ev.chord).toBe('string');
    }
    expect(chorus1.instruments.Keys).toBe(true);

    const pad = chorus1.overrides.Pad!;
    expect(pad.bars!.length).toBeGreaterThanOrEqual(4);
    for (const bar of pad.bars!) {
      const beatKey = Object.keys(bar.notes)[0]!;
      const ev = bar.notes[beatKey]![0]!;
      expect(ev.type).toBe('chord');
      expect(ev.chordType).toBe('twoOctavesMid');
      expect(ev.duration).toBe(4);
    }
    expect(chorus1.instruments.Pad).toBe(true);
  });

  it('the engine-envelope song.json carries the chord-aware Bass override (noteAbsolute strings) on chorus1', () => {
    runAdapter();
    const engineSong = JSON.parse(readFileSync(resolve(OUT, 'song.json'), 'utf-8')) as {
      arrangement: Record<
        string,
        {
          instruments: Record<string, boolean>;
          overrides: {
            Bass?: {
              type?: string;
              bars?: Array<{
                notes: Record<
                  string,
                  Array<{ type: string; note: string; duration: number }>
                >;
              }>;
            };
          };
        }
      >;
    };
    const chorus1 = engineSong.arrangement.chorus1!;
    const bass = chorus1.overrides.Bass!;
    expect(bass.type).toBe('brainRoundtrip');
    expect(bass.bars!.length).toBeGreaterThanOrEqual(4);
    const first4 = bass.bars!.slice(0, 4);
    const firstNotePerBar = first4.map(
      (bar) => bar.notes[Object.keys(bar.notes).sort((a, b) => +a - +b)[0]!]![0]!,
    );
    expect(firstNotePerBar.map((n) => n.type)).toEqual([
      'noteAbsolute',
      'noteAbsolute',
      'noteAbsolute',
      'noteAbsolute',
    ]);
    expect(firstNotePerBar.map((n) => n.note)).toEqual(['c2', 'd2', 'a#2', 'c2']);
    expect(chorus1.instruments.Bass).toBe(true);
  });

  it('multi-segment envelope: every brain songStructure segment is present with explicit per-family flags', () => {
    runAdapter();
    const engineSong = JSON.parse(readFileSync(resolve(OUT, 'song.json'), 'utf-8')) as {
      structure: Array<{ segment: string; bars: Array<{ chords: string[] }> }>;
      arrangement: Record<
        string,
        { instruments?: Record<string, boolean>; overrides: Record<string, unknown> }
      >;
    };
    // The brightPop-vertical-slice resolves to the 14-segment Photograph
    // precedent. Pin the count + segment identities so we catch regressions
    // where the adapter drops segments back to the proof slice.
    expect(engineSong.structure.length).toBeGreaterThanOrEqual(10);
    const segmentNames = engineSong.structure.map((s) => s.segment);
    for (const required of ['intro', 'verse1', 'chorus1', 'outro']) {
      expect(segmentNames).toContain(required);
    }
    // Each segment must have an arrangement block.
    for (const seg of engineSong.structure) {
      expect(engineSong.arrangement[seg.segment]).toBeDefined();
    }
    // Total bar count is strictly greater than the prior 4-bar proof slice.
    const totalBars = engineSong.structure.reduce((n, s) => n + s.bars.length, 0);
    expect(totalBars).toBeGreaterThan(50);
  });
});

describe('engine-render proof (conditional on a built native binary)', () => {
  const wavExists = existsSync(WAV_PATH);
  const itIfWav = wavExists ? it : it.skip;

  itIfWav('renders the full multi-segment song (much longer than the 8s proof slice)', () => {
    // Step 15 (docs/53z): the engine envelope now carries the brain's full
    // 14-segment songStructure (≈ 100+ bars total) instead of the 4-bar
    // chorus1 proof slice. At 120 bpm / 4 beats per bar that's roughly
    // 200s. A render that comes back at the old ~8s would indicate the
    // adapter regressed to single-segment behaviour.
    const stats = analyseWav(WAV_PATH);
    expect(stats.durationSec).toBeGreaterThan(60);
  });

  itIfWav('renders non-silent audio (peak above -40 dB)', () => {
    const stats = analyseWav(WAV_PATH);
    expect(stats.peakDb).toBeGreaterThan(-40);
    expect(stats.rmsDb).toBeGreaterThan(-50);
  });

  itIfWav('WAV format matches the Phase-2 baseline (44.1 kHz / 24-bit / stereo)', () => {
    const stats = analyseWav(WAV_PATH);
    expect(stats.sampleRate).toBe(44100);
    expect(stats.bitsPerSample).toBe(24);
    expect(stats.channels).toBe(2);
  });

  itIfWav('renders Drums+Bass+Keys+Pad energy (RMS healthy for a full-length multi-segment render)', () => {
    // Step 14's single-segment Drums+Bass+Keys+Pad measurement was
    // Pk≈-3.42 dB / RMS≈-18.76 dB on the operator's render. Step 15's
    // multi-segment render mixes in silent/sparse segments (intro, breaks,
    // outro) so the integrated RMS dips below the chorus-only slice. The
    // gate is set wide enough to absorb that mix-down without masking a
    // missing-family regression: if any of Drums/Bass/Keys/Pad goes
    // silent the RMS would drop below -35 dB.
    const stats = analyseWav(WAV_PATH);
    expect(stats.rmsDb).toBeGreaterThan(-35);
  });

  if (!wavExists) {
    // eslint-disable-next-line no-console
    console.warn(
      `[step10] ${WAV_PATH} not found — skipping the engine-render asserts.\n` +
        '         Run the documented sequence in docs/53i-step10-engine-roundtrip.md\n' +
        '         to produce the WAV from the existing native binary.',
    );
  }
});
