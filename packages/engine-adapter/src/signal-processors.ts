// docs/54q — Production wiring for `signalProcessors` lanes.
//
// Brain 53aa emits `arrangement[seg].signalProcessors.<Display> = { type }`
// for `break` / `bridge` segments. The legacy engine reads the tag's
// expanded per-32nd-note automation array under `signalProcessors.<Display>
// .lowPassFilter[]` (each entry has `pointIn32ndNotes`, `pointInSeconds`,
// `value` — Hz for the LP cutoff). Engine's
// `Instrument::applySignalProcessor` (Instrument.cpp:28-72) walks that
// array and writes the corresponding `LowPassPlugin::frequency`
// automation curve.
//
// This module ports the minimum `EffectsClass.getEffect` branches needed
// to expand a brain SP tag into the engine-ready shape:
//   * lowPassFilter / lowPassFilter100 / lowPassFilter300 /
//     lowPassFilter700 / lowPassFilter1000        (static-cutoff with
//                                                  release ramp to 30 kHz)
//   * lowPassFilterSweepUp / lowPassFilter100SweepUp /
//     lowPassFilter300SweepUp / lowPassFilter700SweepUp /
//     lowPassFilter1000SweepUp                    (linear sweep to 30 kHz)
//
// All 10 tags above are in the same legacy switch — they only differ in
// the starting frequency (parsed from digits in the tag, default 100).

export const SUPPORTED_SP_TAGS: readonly string[] = [
  'lowPassFilter',
  'lowPassFilter100',
  'lowPassFilter300',
  'lowPassFilter700',
  'lowPassFilter1000',
  'lowPassFilterSweepUp',
  'lowPassFilter100SweepUp',
  'lowPassFilter300SweepUp',
  'lowPassFilter700SweepUp',
  'lowPassFilter1000SweepUp',
  // docs/62 A7 — volume-automation effects (legacy EffectsClass.getEffect
  // fadeIn/fadeOut). The WASM engine already consumes `signalProcessors.<inst>
  // .volume[]` (Resolver.h → Mixer.h applyLaneAutomation), so these only needed
  // the adapter expander. (fxNoiseRise is a TRANSITION, not a signalProcessor —
  // it needs a noise instrument in the engine; deferred to the transition bridge.)
  'fadeIn',
  'fadeOut',
] as const;

// docs/62 A7 — fade target levels (dB). The WASM engine's volume automation is
// a MULTIPLICATIVE offset on the lane's base gain (Mixer.h: dbToGain(evalCurve(
// volAuto, t, 0.0)), held at the last value), so 0 dB == "no offset / nominal"
// and the curve must END at the steady-state level (not bleed). The legacy
// EffectsClass values (-25/-10) relied on JUCE's `nextDefaultVolume`-on-last-
// point trick (Instrument.cpp:94-101) that does not translate; we adapt the
// intent to the WASM model: fade up from -25 dB to nominal, fade down to -25 dB.
const FADE_QUIET_DB = -25;
const FADE_NOMINAL_DB = 0;

const SP_TAG_SET = new Set<string>(SUPPORTED_SP_TAGS);

/** One LP-cutoff automation point. Matches the legacy `effectDetails.
 *  lowPassFilter[]` row shape exactly so the engine's
 *  `Instrument::applySignalProcessor` finds the fields it expects. */
export interface LowPassAutomationPoint {
  pointIn32ndNotes: number;
  pointInSeconds: number;
  /** Hz; the engine's LowPassPlugin frequency parameter. */
  value: number;
}

/** One volume-automation point (docs/62 A7). Same row shape as the LP point,
 *  but `value` is dB (a multiplicative offset on the lane's base gain). Matches
 *  the legacy `effectDetails.volume[]` shape the engine reads. */
export interface VolumeAutomationPoint {
  pointIn32ndNotes: number;
  pointInSeconds: number;
  /** dB offset; the engine's lane volume automation. */
  value: number;
}

/** The full `signalProcessors.<Display>` block the engine reads. A block
 *  carries EITHER `lowPassFilter[]` (filter tags) OR `volume[]` (fade tags). */
export interface SignalProcessorBlock {
  /** Brain tag, echoed for traceability; engine ignores this field. */
  type: string;
  lowPassFilter?: LowPassAutomationPoint[];
  volume?: VolumeAutomationPoint[];
}

export interface ComputeSignalProcessorInput {
  /** Brain tag (one of SUPPORTED_SP_TAGS). */
  tag: string;
  /** segment.bars.length — same as the legacy `lengthOfCurrentSegmentInBars`. */
  segmentLengthInBars: number;
  /** song tempo (BPM). */
  tempo: number;
}

/** Returns null for unsupported tags so the adapter can skip with a
 *  diagnostic. Output matches the legacy `EffectsClass.getEffect`
 *  result for the same tag at the same (lengthInBars, tempo). */
export function computeSignalProcessor(input: ComputeSignalProcessorInput): SignalProcessorBlock | null {
  if (!SP_TAG_SET.has(input.tag)) return null;
  const tempo = input.tempo;
  const bars = input.segmentLengthInBars;

  // segLengthInSeconds = bars * 4 beats * (60/tempo) sec/beat.
  const segLenSec = (bars * 4 * 60) / tempo;
  const segLen32 = bars * 32;

  // docs/62 A7 — fadeIn/fadeOut → a 2-point dB volume ramp over the whole
  // segment (legacy EffectsClass.js:114-144). fadeIn ramps up from quiet to
  // nominal (held after → no bleed); fadeOut ramps down from nominal to quiet.
  if (input.tag === 'fadeIn' || input.tag === 'fadeOut') {
    const [from, to] =
      input.tag === 'fadeIn'
        ? [FADE_QUIET_DB, FADE_NOMINAL_DB]
        : [FADE_NOMINAL_DB, FADE_QUIET_DB];
    return {
      type: input.tag,
      volume: [
        { pointIn32ndNotes: 0, pointInSeconds: 0, value: from },
        { pointIn32ndNotes: segLen32, pointInSeconds: segLenSec, value: to },
      ],
    };
  }

  const frequency = parseStartFrequency(input.tag);
  const isSweep = input.tag.endsWith('SweepUp');

  if (isSweep) {
    // Sweep from `frequency` Hz at t=0 to 30000 Hz at segment end.
    return {
      type: input.tag,
      lowPassFilter: [
        { pointIn32ndNotes: 0,         pointInSeconds: 0,         value: frequency },
        { pointIn32ndNotes: segLen32,  pointInSeconds: segLenSec, value: 30000 },
      ],
    };
  }

  // Static cutoff for the segment, then snap back to 30000 Hz at +1/32 past
  // the segment end (so the next segment isn't filtered). Mirrors the legacy
  // 3-point output exactly.
  const segLenPlus132Sec = (bars + 1 / 32) * 4 * 60 / tempo;
  return {
    type: input.tag,
    lowPassFilter: [
      { pointIn32ndNotes: 0,            pointInSeconds: 0,            value: frequency },
      { pointIn32ndNotes: segLen32,     pointInSeconds: segLenSec,    value: frequency },
      { pointIn32ndNotes: segLen32 + 1, pointInSeconds: segLenPlus132Sec, value: 30000 },
    ],
  };
}

/** Extracts the start frequency from the tag's embedded digits. Defaults
 *  to 100 Hz when the tag has none (`lowPassFilter`, `lowPassFilterSweepUp`).
 *  Mirrors the legacy `parameters['type'].match(/[0-9]+/)` regex. */
function parseStartFrequency(tag: string): number {
  const m = tag.match(/[0-9]+/);
  if (!m) return 100;
  const n = Number.parseInt(m[0], 10);
  if (!Number.isFinite(n) || n <= 0) return 100;
  return n;
}

/** True if the tag is in the supported set. */
export function isSupportedSignalProcessorTag(tag: string): boolean {
  return SP_TAG_SET.has(tag);
}
