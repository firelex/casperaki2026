// Guard against the silent-imbalance class of bug: an instrument whose
// `lowLevelType` the engine's volume table does not recognise.
//
// The engine applies per-`lowLevelType` mix gain in
// `FX::getInstrumentTargetVolume(lowLevelType, genre)`
// (casperaki_engine Source/FX.h:523) — a long lookup that ends in a
// `return 0` default. Any `lowLevelType` the adapter emits that is NOT
// in that table is silently rendered at unity gain (0 dB) instead of the
// legacy-ported per-type level. That is exactly what bit the percussion
// loops (catalog suffix `_<bpm>bpm` missed the bare key). To stop the
// next such drift from being silent, the adapter validates every emitted
// `lowLevelType` against the set below and records a `warning` diagnostic
// for any miss.
//
// SYNC: this set mirrors two regions of casperaki_engine Source/FX.h and
// MUST be kept in step with them:
//   * getInstrumentTargetVolume keys  (FX.h:523-738) — the volume table
//   * getFamilyForLowLevelType keys   (FX.h:234-353) — types that route
//     to a family but deliberately take the table's 0 dB default
//     (cymbalsSwell, drumKitsAcoustic/Electronic, fx8bitArcade,
//     hiHatsOpen). These are recognised (intentional unity gain), not
//     drift, so they belong in the set.

/** The kit-parent `lowLevelType` the engine handles specially: the
 *  Sequencer routes it to `Drums::setInstrumentTargetVolumes`, which
 *  looks up each *sub-instrument's* `lowLevelType` instead — so the
 *  parent itself is never passed to the volume table and must not be
 *  flagged. (Sequencer.cpp:513-519.) */
export const DRUMS_KIT_LOW_LEVEL_TYPE = 'drums';

/** Every `lowLevelType` the engine recognises for mix gain — the union
 *  of the volume-table keys and the family-map-only keys. Membership
 *  means "the engine deliberately handles this type"; absence means it
 *  would silently fall through to the 0 dB default. */
export const RECOGNIZED_LOW_LEVEL_TYPES: ReadonlySet<string> = new Set([
  // -- getInstrumentTargetVolume keys (FX.h:523-738) --
  'acousticGuitars12StringMono',
  'acousticGuitars12StringStereo',
  'acousticGuitarsBanjoMono',
  'acousticGuitarsBanjoStereo',
  'acousticGuitarsMandolineMono',
  'acousticGuitarsMandolineStereo',
  'acousticGuitarsNylonMono',
  'acousticGuitarsNylonStereo',
  'acousticGuitarsSteelMono',
  'acousticGuitarsSteelStereo',
  'acousticGuitarsUkuleleMono',
  'acousticGuitarsUkuleleStereo',
  'bassesAcoustic',
  'bassesElectric',
  'bassesSynth808',
  'bassesSynthDistorted',
  'bassesSynthPluck',
  'bassesSynthSoft',
  'bassesSynthSub',
  'bassesSynthWobble',
  'clapsSnapsClapsAcoustic',
  'clapsSnapsClapsElectronic',
  'clapsSnapsClapsPreshifted',
  'clapsSnapsSnapsAcoustic',
  'clapsSnapsSnapsElectronic',
  'cymbalsCrashHit',
  'cymbalsElectronic',
  'cymbalsOrchestral',
  'cymbalsReverse',
  'cymbalsRideBell',
  'cymbalsRideRim',
  'electricGuitarsDominoMono',
  'electricGuitarsDominoStereo',
  'electricGuitarsLpChorusMono',
  'electricGuitarsLpChorusStereo',
  'electricGuitarsStratDriveMono',
  'electricGuitarsStratDriveStereo',
  'electricGuitarsWarmCrunchMono',
  'electricGuitarsWarmCrunchStereo',
  'fxAtmosphere',
  'fxDownlifter',
  'fxFretNoise',
  'fxHighImpact',
  'fxLowImpact',
  'fxNoiseRise',
  'fxOther',
  'fxReverse',
  'fxTonalReverse',
  'fxTransition',
  'fxUplifter',
  'hiHatsClosedAcoustic',
  'hiHatsClosedElectronic',
  'hiHatsOpenAcoustic',
  'hiHatsOpenElectronic',
  'keysAcousticPiano',
  'keysChoir',
  'keysElectronicPiano',
  'keysOrgan',
  'kickDrumsAcoustic',
  'kickDrumsElectronic',
  'leadSynthsAnalog',
  'leadSynthsBright',
  'leadSynthsDistorted',
  'leadSynthsSoft',
  'orchestralBassLegato',
  'orchestralBassSolo',
  'orchestralCelloLegato',
  'orchestralCelloSolo',
  'orchestralHighBrassLegato',
  'orchestralHighBrassStaccato',
  'orchestralHighStringsPizzicato',
  'orchestralHighStringsStaccato',
  'orchestralHighStringsTremolo',
  'orchestralHit',
  'orchestralLowBrassLegato',
  'orchestralLowBrassStaccato',
  'orchestralLowStringsPizzicato',
  'orchestralLowStringsStaccato',
  'orchestralLowStringsTremolo',
  'orchestralViolaLegato',
  'orchestralViolaSolo',
  'orchestralViolinLegato',
  'orchestralViolinSolo',
  'orchestralWoodwindsLegato',
  'orchestralWoodwindsStaccato',
  'percussionBreaksBuildups',
  'percussionBreaksFills',
  'percussionLoopsAcoustic',
  'percussionLoopsElectronic',
  'percussionMiscAcousticHigh',
  'percussionMiscAcousticLow',
  'percussionMiscElectronicHigh',
  'percussionMiscElectronicLow',
  'percussionMiscVocalShout',
  'popBrassBrightBrassSectionLegato',
  'popBrassBrightBrassSectionStaccato',
  'popBrassReedsSectionLegato',
  'popBrassReedsSectionStaccato',
  'popBrassReedsSoloLegato',
  'popBrassReedsSoloStaccato',
  'popBrassSoloLegato',
  'popBrassSoloStaccato',
  'popBrassVintageBrassSectionLegato',
  'popBrassVintageBrassSectionStaccato',
  'popHighStringsLegato',
  'popHighStringsPizzicato',
  'popHighStringsStaccato',
  'popHighStringsTremolo',
  'popLowStringsLegato',
  'popLowStringsPizzicato',
  'popLowStringsStaccato',
  'popLowStringsTremolo',
  'shakersAcoustic',
  'shakersElectronic',
  'snareDrumsAcoustic',
  'snareDrumsElectronic',
  'synthsArpeggiated',
  'synthsBrightPad',
  'synthsPlucked',
  'synthsSoftPad',
  'tomsAcoustic',
  'tomsElectronic',
  'vocalsLaSinger',
  'vocalsNaSinger',
  // -- family-map-only keys (FX.h:234-353): recognised, intentional 0 dB --
  'cymbalsSwell',
  'drumKitsAcoustic',
  'drumKitsElectronic',
  'fx8bitArcade',
  'hiHatsOpen',
]);

/** One emitted `lowLevelType` the engine would not recognise. */
export interface UnrecognizedLowLevelType {
  /** the inst-N.json the value was emitted in. */
  filename: string;
  /** the offending `lowLevelType`. */
  lowLevelType: string;
  /** where in the payload it sat — the top-level instrument, or a named
   *  drum sub-instrument. */
  where: string;
}

interface EmittedInst {
  filename: string;
  /** the engine-ready inst-N.json payload; typed `unknown` upstream
   *  (InstrumentEnvelopeFile) so we narrow it here. */
  json: unknown;
}

/** Scan every emitted instrument for a `lowLevelType` the engine's
 *  volume table does not recognise. For the drum kit (parent
 *  `lowLevelType === 'drums'`) the engine looks up each sub-instrument
 *  instead, so we recurse into `subInstruments` and skip the parent. */
export function collectUnrecognizedLowLevelTypes(
  instruments: readonly EmittedInst[],
): UnrecognizedLowLevelType[] {
  const out: UnrecognizedLowLevelType[] = [];
  for (const inst of instruments) {
    const json = (inst.json ?? {}) as {
      lowLevelType?: unknown;
      subInstruments?: unknown;
    };
    const top = json.lowLevelType;
    if (top === DRUMS_KIT_LOW_LEVEL_TYPE) {
      const subs = json.subInstruments;
      if (subs && typeof subs === 'object') {
        for (const [name, sub] of Object.entries(
          subs as Record<string, { lowLevelType?: unknown }>,
        )) {
          const llt = sub?.lowLevelType;
          if (typeof llt === 'string' && !RECOGNIZED_LOW_LEVEL_TYPES.has(llt)) {
            out.push({
              filename: inst.filename,
              lowLevelType: llt,
              where: `subInstruments.${name}`,
            });
          }
        }
      }
      continue;
    }
    if (typeof top === 'string' && !RECOGNIZED_LOW_LEVEL_TYPES.has(top)) {
      out.push({
        filename: inst.filename,
        lowLevelType: top,
        where: 'lowLevelType',
      });
    }
  }
  return out;
}
