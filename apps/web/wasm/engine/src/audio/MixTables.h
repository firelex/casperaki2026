// Phase 2 mix data tables — a faithful, portable transcription of the native
// engine's FX.h (docs/63 §2-4). These are pure data functions (no DSP, no JUCE),
// so transcribing them verbatim IS the faithful port. They drive the per-lane mix
// (Scope A: getInstrumentTargetVolume → per-voice gainDb) and the routing graph
// (Scope B: getFxGroup + instrumentFxSends + the Sequencer.cpp send overrides).
//
// Source anchors (~/apps/casperaki_engine/Source/FX.h):
//   - getInstrumentTargetVolume   FX.h:523-739  (sequential if-chain; order matters)
//   - typeMappingTable            FX.h:221-355  (lowLevelType -> fxGroup)
//   - instrumentFxSettings        FX.h:372-387  (fxGroup -> {reverb,delay,chorus} dB)
//   - send overrides              Sequencer.cpp:251-336 (applied in MixGraph, not here)
//   - master volume -1 dB         Sequencer.cpp:210 / CasperakiEngine.cpp:175
#pragma once

#include <cmath>
#include <string>
#include <unordered_map>

namespace casperaki {
namespace mix {

// VolumeAndPanPlugin / SamplerSound gainDb -> linear. The tracktion fader dance
// (Gain.h) collapses to 10^(db/20); db <= -100 is the mute floor (a -100 send is
// "off"). Matches decibelsToVolumeFaderPosition's <=-100 -> 0.
inline float dbToGain(double db) {
    return db <= -100.0 ? 0.0f : (float)std::pow(10.0, db / 20.0);
}

// Tracktion volume-fader law (tracktion_AudioUtilities.cpp, volScaleFactor=20).
// VOLUME automation curves interpolate in FADER-POSITION space, not dB: native
// stores each fade dB step as decibelsToVolumeFaderPosition(db) and lerps THAT
// (Instrument.cpp:96, linear segment), then the volume plugin maps position->gain.
// faderPosToGain(dbToFaderPos(db)) == dbToGain(db), so endpoints are unchanged;
// only the shape BETWEEN points differs (a dB-linear fade sags up to ~9 dB at its
// midpoint vs the position-linear curve). Use these for fade-in/out automation.
inline double dbToFaderPos(double db) {
    return db > -100.0 ? std::exp((db - 6.0) / 20.0) : 0.0;
}
inline float faderPosToGain(double pos) {
    return pos > 0.0 ? (float)std::pow(10.0, ((20.0 * std::log(pos)) + 6.0) / 20.0) : 0.0f;
}

// FX.h:523-739 getInstrumentTargetVolume(lowLevelType, genre) -> dB. Verbatim
// order (genre-specific rows precede the generic fallback; first match wins).
inline double getInstrumentTargetVolume(const std::string& t, const std::string& g) {
    if (t == "acousticGuitarsNylonMono" && g == "brightPop") return -3;
    if (t == "acousticGuitarsNylonStereo" && g == "brightPop") return -3;
    if (t == "acousticGuitarsSteelMono" && g == "brightPop") return -3;
    if (t == "acousticGuitarsSteelStereo" && g == "brightPop") return -3;
    if (t == "acousticGuitars12StringMono" && g == "brightPop") return -3;
    if (t == "acousticGuitars12StringStereo" && g == "brightPop") return -3;
    if (t == "acousticGuitarsBanjoMono" && g == "brightPop") return -3;
    if (t == "acousticGuitarsBanjoStereo" && g == "brightPop") return -3;
    if (t == "acousticGuitarsMandolineMono" && g == "brightPop") return -3;
    if (t == "acousticGuitarsMandolineStereo" && g == "brightPop") return -3;
    if (t == "acousticGuitarsUkuleleMono" && g == "brightPop") return -3;
    if (t == "acousticGuitarsUkuleleStereo" && g == "brightPop") return -3;

    if (t == "acousticGuitarsNylonMono") return -5;
    if (t == "acousticGuitarsNylonStereo") return -5;
    if (t == "acousticGuitarsSteelMono") return -5;
    if (t == "acousticGuitarsSteelStereo") return -5;
    if (t == "acousticGuitars12StringMono") return -5;
    if (t == "acousticGuitars12StringStereo") return -5;
    if (t == "acousticGuitarsBanjoMono") return -5;
    if (t == "acousticGuitarsBanjoStereo") return -5;
    if (t == "acousticGuitarsMandolineMono") return -5;
    if (t == "acousticGuitarsMandolineStereo") return -5;
    if (t == "acousticGuitarsUkuleleMono") return -5;
    if (t == "acousticGuitarsUkuleleStereo") return -5;

    if (t == "bassesAcoustic") return 0;
    if (t == "bassesElectric") return 0;
    if (t == "bassesSynthSoft") return 0;
    if (t == "bassesSynthDistorted") return 0;
    if (t == "bassesSynthSub") return 0;
    if (t == "bassesSynthPluck") return 0;
    if (t == "bassesSynth808") return 0;
    if (t == "bassesSynthWobble") return 0;

    if (t == "clapsSnapsClapsAcoustic" && g == "rock") return -12;
    if (t == "clapsSnapsClapsAcoustic") return -10;
    if (t == "clapsSnapsClapsElectronic" && g == "rock") return -12;
    if (t == "clapsSnapsClapsElectronic") return -10;
    if (t == "clapsSnapsClapsPreshifted" && g == "rock") return -12;
    if (t == "clapsSnapsClapsPreshifted") return -10;
    if (t == "clapsSnapsSnapsAcoustic" && g == "rock") return -12;
    if (t == "clapsSnapsSnapsAcoustic") return -10;
    if (t == "clapsSnapsSnapsElectronic" && g == "rock") return -12;
    if (t == "clapsSnapsSnapsElectronic") return -10;

    if (t == "cymbalsCrashHit") return 0;
    if (t == "cymbalsElectronic") return 0;
    if (t == "cymbalsOrchestral") return 0;
    if (t == "cymbalsReverse") return 0;
    if (t == "cymbalsRideRim" && g == "latin") return -21;
    if (t == "cymbalsRideRim" && g == "organicVibes") return -19;
    if (t == "cymbalsRideRim" && g == "ballad") return -15;
    if (t == "cymbalsRideRim") return -15;
    if (t == "cymbalsRideBell" && g == "latin") return -21;
    if (t == "cymbalsRideBell" && g == "ballad") return -15;
    if (t == "cymbalsRideBell" && g == "organicVibes") return -19;
    if (t == "cymbalsRideBell") return -15;

    if (t == "electricGuitarsDominoMono") return -5;
    if (t == "electricGuitarsDominoStereo") return -5;
    if (t == "electricGuitarsLpChorusMono") return -5;
    if (t == "electricGuitarsLpChorusStereo") return -5;
    if (t == "electricGuitarsStratDriveMono") return -5;
    if (t == "electricGuitarsStratDriveStereo") return -5;
    if (t == "electricGuitarsWarmCrunchMono") return -5;
    if (t == "electricGuitarsWarmCrunchStereo") return -5;

    if (t == "fxAtmosphere") return -10;
    if (t == "fxDownlifter") return -15;
    if (t == "fxFretNoise" && g == "edm") return 0;
    if (t == "fxFretNoise" && g == "rock") return 0;
    if (t == "fxFretNoise") return 0;
    if (t == "fxHighImpact") return -10;
    if (t == "fxLowImpact") return -10;
    if (t == "fxNoiseRise") return -10;
    if (t == "fxOther") return -10;
    if (t == "fxReverse") return -10;
    if (t == "fxTonalReverse") return -10;
    if (t == "fxTransition") return -10;
    if (t == "fxUplifter") return -10;

    if (t == "hiHatsClosedAcoustic" && g == "urban") return -14;
    if (t == "hiHatsClosedAcoustic" && g == "rock") return -21;
    if (t == "hiHatsClosedAcoustic") return -12;
    if (t == "hiHatsClosedElectronic" && g == "edm") return -14;
    if (t == "hiHatsClosedElectronic" && g == "urban") return -12;
    if (t == "hiHatsClosedElectronic" && g == "organicVibes") return -13;
    if (t == "hiHatsClosedElectronic") return -10;
    if (t == "hiHatsOpenAcoustic" && g == "rock") return -15;
    if (t == "hiHatsOpenAcoustic") return -12;
    if (t == "hiHatsOpenElectronic") return -25;

    if (t == "keysAcousticPiano" && g == "ballad") return -4;
    if (t == "keysAcousticPiano" && g == "latin") return -3;
    if (t == "keysAcousticPiano" && g == "edm") return -4;
    if (t == "keysAcousticPiano" && g == "schlager") return -4;
    if (t == "keysAcousticPiano" && g == "organicVibes") return -7;
    if (t == "keysAcousticPiano" && g == "rock") return -8;
    if (t == "keysAcousticPiano" && g == "urban") return -5;
    if (t == "keysAcousticPiano") return 0;

    if (t == "keysElectronicPiano" && g == "latin") return -3;
    if (t == "keysElectronicPiano" && g == "edm") return -4;
    if (t == "keysElectronicPiano" && g == "schlager") return -4;
    if (t == "keysElectronicPiano" && g == "organicVibes") return -6;
    if (t == "keysElectronicPiano" && g == "urban") return -9;
    if (t == "keysElectronicPiano" && g == "rock") return -7;
    if (t == "keysElectronicPiano") return 0;

    if (t == "keysOrgan") return 0;
    if (t == "keysChoir") return 0;

    if (t == "kickDrumsAcoustic" && g == "ballad") return -2;
    if (t == "kickDrumsAcoustic") return 0;
    if (t == "kickDrumsElectronic" && g == "urban") return 2;
    if (t == "kickDrumsElectronic") return 0;

    if (t == "leadSynthsAnalog") return 0;
    if (t == "leadSynthsBright") return -5;
    if (t == "leadSynthsSoft") return -3;
    if (t == "leadSynthsDistorted") return 0;

    if (t == "orchestralViolinLegato") return -7;
    if (t == "orchestralViolaLegato") return -7;
    if (t == "orchestralCelloLegato") return -7;
    if (t == "orchestralBassLegato") return -7;
    if (t == "orchestralHighStringsTremolo") return -7;
    if (t == "orchestralLowStringsTremolo") return -7;
    if (t == "orchestralHighStringsStaccato") return -7;
    if (t == "orchestralLowStringsStaccato") return -7;
    if (t == "orchestralHighStringsPizzicato") return -7;
    if (t == "orchestralLowStringsPizzicato") return -7;
    if (t == "orchestralViolinSolo") return -7;
    if (t == "orchestralViolaSolo") return -7;
    if (t == "orchestralCelloSolo") return -7;
    if (t == "orchestralBassSolo") return -7;
    if (t == "orchestralLowBrassLegato") return -7;
    if (t == "orchestralLowBrassStaccato") return -7;
    if (t == "orchestralHighBrassLegato") return -7;
    if (t == "orchestralHighBrassStaccato") return -7;
    if (t == "orchestralHit") return -7;
    if (t == "orchestralWoodwindsLegato") return -7;
    if (t == "orchestralWoodwindsStaccato") return -7;

    if (t == "percussionBreaksBuildups") return 0;
    if (t == "percussionBreaksFills") return 5;

    if (t == "percussionLoopsAcoustic" && g == "ballad") return -10;
    if (t == "percussionLoopsAcoustic") return -7;
    if (t == "percussionLoopsElectronic" && g == "brightPop") return -5;
    if (t == "percussionLoopsElectronic" && g == "ballad") return -12;
    if (t == "percussionLoopsElectronic" && g == "latin") return 0;
    if (t == "percussionLoopsElectronic" && g == "edm") return -8;
    if (t == "percussionLoopsElectronic") return -2.5;

    if (t == "percussionMiscAcousticHigh") return 0;
    if (t == "percussionMiscAcousticLow") return 0;
    if (t == "percussionMiscElectronicHigh") return 0;
    if (t == "percussionMiscElectronicLow") return 0;

    if (t == "percussionMiscVocalShout") return 0;

    if (t == "popBrassBrightBrassSectionLegato") return 0;
    if (t == "popBrassBrightBrassSectionStaccato") return 0;
    if (t == "popBrassReedsSectionLegato") return 0;
    if (t == "popBrassReedsSectionStaccato") return 0;
    if (t == "popBrassReedsSoloLegato") return 0;
    if (t == "popBrassReedsSoloStaccato") return 0;
    if (t == "popBrassSoloLegato") return 0;
    if (t == "popBrassSoloStaccato") return 0;
    if (t == "popBrassVintageBrassSectionLegato") return 0;
    if (t == "popBrassVintageBrassSectionStaccato") return 0;
    if (t == "popHighStringsLegato") return -7;
    if (t == "popHighStringsPizzicato" && g == "organicVibes") return -10;
    if (t == "popHighStringsPizzicato" && g == "urban") return -12.5;
    if (t == "popHighStringsPizzicato") return -7;
    if (t == "popHighStringsStaccato" && g == "organicVibes") return -10;
    if (t == "popHighStringsStaccato" && g == "urban") return -12.5;
    if (t == "popHighStringsStaccato") return -7;
    if (t == "popHighStringsTremolo") return -17;
    if (t == "popLowStringsLegato") return -7;
    if (t == "popLowStringsPizzicato") return -7;
    if (t == "popLowStringsStaccato") return -7;
    if (t == "popLowStringsTremolo") return -7;

    if (t == "shakersAcoustic") return -10;
    if (t == "shakersElectronic") return -10;

    if (t == "snareDrumsAcoustic") return 0 - 3;
    if (t == "snareDrumsElectronic" && g == "organicVibes") return -9;
    if (t == "snareDrumsElectronic") return -6;

    if (t == "synthsSoftPad" && (g == "ballad" || g == "brightPop" || g == "rock")) return -21;
    if (t == "synthsSoftPad") return -17;
    if (t == "synthsBrightPad" && (g == "ballad" || g == "brightPop" || g == "rock")) return -21;
    if (t == "synthsBrightPad") return -17;

    if (t == "synthsArpeggiated") return 0;

    if (t == "synthsPlucked" && g == "latin") return -3;
    if (t == "synthsPlucked" && g == "urban") return -2;
    if (t == "synthsPlucked") return -7;

    if (t == "tomsAcoustic" && g == "rock") return -3;
    if (t == "tomsAcoustic") return 0;
    if (t == "tomsElectronic") return -17;

    if (t == "vocalsLaSinger") return 0;
    if (t == "vocalsNaSinger") return 0;

    return 0;
}

// FX.h:221-355 typeMappingTable — lowLevelType -> fxGroup string. Unmapped -> the
// engine's getFXGroupFromLowLevelType fallback "drums" (FX.h:368).
inline const std::string& getFxGroup(const std::string& lowLevelType) {
    static const std::unordered_map<std::string, std::string> table = {
        {"fxAtmosphere","fx"},{"fxDownlifter","fx"},{"fxFretNoise","fx"},{"fxHighImpact","fx"},
        {"fxLowImpact","fx"},{"fxNoiseRise","fx"},{"fxOther","fx"},{"fx8bitArcade","fx"},
        {"fxReverse","fx"},{"fxTonalReverse","fx"},{"fxTransition","fx"},{"fxUplifter","fx"},
        {"kickDrumsAcoustic","kicks"},{"kickDrumsElectronic","kicks"},
        {"clapsSnapsClapsAcoustic","drums"},{"clapsSnapsClapsElectronic","drums"},
        {"clapsSnapsClapsPreshifted","drums"},{"clapsSnapsSnapsAcoustic","drums"},
        {"clapsSnapsSnapsElectronic","drums"},{"cymbalsCrashHit","drums"},{"cymbalsElectronic","drums"},
        {"cymbalsOrchestral","drums"},{"cymbalsReverse","drums"},{"cymbalsRideBell","drums"},
        {"cymbalsRideRim","drums"},{"cymbalsSwell","drums"},{"drumKitsAcoustic","drums"},
        {"drumKitsElectronic","drums"},{"hiHatsClosedAcoustic","drums"},{"hiHatsClosedElectronic","drums"},
        {"hiHatsOpen","drums"},{"shakersAcoustic","drums"},{"shakersElectronic","drums"},
        {"snareDrumsAcoustic","drums"},{"snareDrumsElectronic","drums"},{"tomsAcoustic","drums"},
        {"tomsElectronic","drums"},
        {"percussionBreaksBuildups","percussion"},{"percussionBreaksFills","percussion"},
        {"percussionLoopsAcoustic","percussion"},{"percussionLoopsElectronic","percussion"},
        {"percussionMiscAcousticHigh","percussion"},{"percussionMiscAcousticLow","percussion"},
        {"percussionMiscElectronicHigh","percussion"},{"percussionMiscElectronicLow","percussion"},
        {"percussionMiscVocalShout","percussion"},
        {"bassesAcoustic","bass"},{"bassesElectric","bass"},{"bassesSynth808","bass"},
        {"bassesSynthDistorted","bass"},{"bassesSynthPluck","bass"},{"bassesSynthSoft","bass"},
        {"bassesSynthSub","bass"},{"bassesSynthWobble","bass"},
        {"keysAcousticPiano","keys"},{"keysChoir","keys"},{"keysElectronicPiano","keys"},{"keysOrgan","keys"},
        {"synthsArpeggiated","synths"},{"synthsBrightPad","synths"},{"synthsPlucked","synths"},{"synthsSoftPad","synths"},
        {"leadSynthsAnalog","leadSynths"},{"leadSynthsBright","leadSynths"},
        {"leadSynthsDistorted","leadSynths"},{"leadSynthsSoft","leadSynths"},
        {"acousticGuitars12StringMono","acousticGuitars"},{"acousticGuitars12StringStereo","acousticGuitars"},
        {"acousticGuitarsBanjoMono","acousticGuitars"},{"acousticGuitarsBanjoStereo","acousticGuitars"},
        {"acousticGuitarsMandolineMono","acousticGuitars"},{"acousticGuitarsMandolineStereo","acousticGuitars"},
        {"acousticGuitarsNylonMono","acousticGuitars"},{"acousticGuitarsNylonStereo","acousticGuitars"},
        {"acousticGuitarsSteelMono","acousticGuitars"},{"acousticGuitarsSteelStereo","acousticGuitars"},
        {"acousticGuitarsUkuleleMono","acousticGuitars"},{"acousticGuitarsUkuleleStereo","acousticGuitars"},
        {"electricGuitarsDominoMono","electricGuitars"},{"electricGuitarsDominoStereo","electricGuitars"},
        {"electricGuitarsLpChorusMono","electricGuitars"},{"electricGuitarsLpChorusStereo","electricGuitars"},
        {"electricGuitarsStratDriveMono","electricGuitars"},{"electricGuitarsStratDriveStereo","electricGuitars"},
        {"electricGuitarsWarmCrunchMono","electricGuitars"},{"electricGuitarsWarmCrunchStereo","electricGuitars"},
        {"orchestralBassLegato","orchestral"},{"orchestralBassSolo","orchestral"},
        {"orchestralCelloLegato","orchestral"},{"orchestralCelloSolo","orchestral"},
        {"orchestralHighBrassLegato","orchestral"},{"orchestralHighBrassStaccato","orchestral"},
        {"orchestralHighStringsPizzicato","orchestral"},{"orchestralHighStringsStaccato","orchestral"},
        {"orchestralHighStringsTremolo","orchestral"},{"orchestralHit","orchestral"},
        {"orchestralLowBrassLegato","orchestral"},{"orchestralLowBrassStaccato","orchestral"},
        {"orchestralLowStringsPizzicato","orchestral"},{"orchestralLowStringsStaccato","orchestral"},
        {"orchestralLowStringsTremolo","orchestral"},{"orchestralViolaLegato","orchestral"},
        {"orchestralViolaSolo","orchestral"},{"orchestralViolinLegato","orchestral"},
        {"orchestralViolinSolo","orchestral"},{"orchestralWoodwindsLegato","orchestral"},
        {"orchestralWoodwindsStaccato","orchestral"},
        {"popBrassBrightBrassSectionLegato","orchestral"},{"popBrassBrightBrassSectionStaccato","orchestral"},
        {"popBrassReedsSectionLegato","orchestral"},{"popBrassReedsSectionStaccato","orchestral"},
        {"popBrassReedsSoloLegato","orchestral"},{"popBrassReedsSoloStaccato","orchestral"},
        {"popBrassSoloLegato","orchestral"},{"popBrassSoloStaccato","orchestral"},
        {"popBrassVintageBrassSectionLegato","orchestral"},{"popBrassVintageBrassSectionStaccato","orchestral"},
        {"popHighStringsLegato","orchestral"},{"popHighStringsPizzicato","orchestral"},
        {"popHighStringsStaccato","orchestral"},{"popHighStringsTremolo","orchestral"},
        {"popLowStringsLegato","orchestral"},{"popLowStringsPizzicato","orchestral"},
        {"popLowStringsStaccato","orchestral"},{"popLowStringsTremolo","orchestral"},
        {"vocalsLaSinger","vocals"},{"vocalsNaSinger","vocals"},
    };
    static const std::string kDrums = "drums";
    auto it = table.find(lowLevelType);
    return it != table.end() ? it->second : kDrums;
}

// FX.h:372-387 instrumentFxSettings — fxGroup -> {reverb, delay, chorus} dB (the
// per-lane aux-send base levels; -100 = muted send). Genre/type overrides live in
// the routing graph (Sequencer.cpp:251-336), applied on top of this base.
struct FxSends { float reverb, delay, chorus; };
inline FxSends instrumentFxSends(const std::string& fxGroup) {
    static const std::unordered_map<std::string, FxSends> table = {
        {"fx", {-100,-100,-100}}, {"kicks", {-100,-100,-100}}, {"drums", {-25,-100,-100}},
        {"percussion", {-100,-100,-100}}, {"bass", {-100,-100,-100}}, {"keys", {-25,-100,-25}},
        {"synths", {-20,-25,-14}}, {"leadSynths", {-10,-0,-14}}, {"acousticGuitars", {-25,-25,-25}},
        {"electricGuitars", {-20,-20,-10}}, {"orchestral", {-100,-100,-100}}, {"snares", {-100,-100,-100}},
        {"toms", {-100,-100,-100}}, {"vocals", {-25,-25,-14}},
    };
    auto it = table.find(fxGroup);
    return it != table.end() ? it->second : FxSends{-25,-100,-100}; // drums fallback
}

// The per-lane aux send levels (dB) the engine actually writes: the fxGroup base
// (instrumentFxSends) plus the Sequencer.cpp:251-336 per-lowLevelType/genre
// overrides (docs/63 §3). Returns {reverb, delay, chorus}; -100 = muted send.
// The drum reverb overrides are keyed on the fxGroup "drums" (not "kicks") since
// the WASM drum lanes all carry the parent "drums" lowLevelType.
inline FxSends laneSendsDb(const std::string& fxGroup, const std::string& t, const std::string& g) {
    FxSends s = instrumentFxSends(fxGroup);
    if (t == "acousticGuitarsNylonMono" || t == "acousticGuitarsNylonStereo" ||
        t == "acousticGuitarsSteelMono" || t == "acousticGuitarsSteelStereo") {
        s.reverb -= 8; s.delay -= 8; s.chorus -= 8;
    } else if (t == "synthsBrightPad" || t == "synthsSoftPad") {
        s.reverb = -14;
    } else if (t == "synthsPlucked") {
        s.delay = -10;
    } else if (t == "keysAcousticPiano") {
        s.reverb = -14; s.delay = -10;
    }
    // NOTE (docs/65): the legacy oracle's per-genre drum-reverb overrides
    // (ballad -14 / rock -18) are DEAD CODE — Sequencer.cpp's `if (lowLevelType
    // == "drums")` handles the Drums instrument before the `else if (genre ==
    // ...)` branches, and no standalone snareDrums regular instrument is ever
    // emitted. The oracle therefore renders drum reverb at the group base (-25)
    // in every genre; applying -14/-18 here diverged WASM above the oracle. The
    // reference is ~/apps/casperaki_engine, so drum reverb stays at the base.
    return s;
}

// Master volume plugin (Sequencer.cpp:210 / CasperakiEngine.cpp:175).
constexpr double kMasterVolumeDb = -1.0;

} // namespace mix
} // namespace casperaki
