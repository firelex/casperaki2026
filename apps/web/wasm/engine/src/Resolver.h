// Resolution entry point for the WASM render engine (docs/60 Phase 1).
//
// Re-implements — does NOT lift — the `song.json` -> resolved-schedule logic
// from casperaki_engine (Sequencer.cpp::setSong + the instruments/*.h families),
// which is te::-coupled and cannot compile under Emscripten. Input is the
// `song.json` boundary contract (+ inst-N.json); output is the engine-internal
// ResolvedEvents IR, serialized as `casperaki/resolved-events/v1`.
//
// Ported so far:
//   - Structure/timeline math: segment -> bars -> beats -> seconds, edit length.
//     (Sequencer.cpp:386,408-499 — 4 beats/bar, single tempo from song.tempo.)
//   - Tonal lanes (Tonal.h): Synths-class + Bass — note/noteAbsolute/chord/
//     noteRelative, chord-breaking, beat-velocity, sustain tail, overlap
//     shortener. (TonalInstrument.h / SequencerUtils.h / Synths.h / Bass.h)
//
//   - Drum step lanes (Drums.h): grid expansion -> four step clips per segment,
//     base-pattern + fills, setNote('x'/'0') semantics. Step hits assert exact.
//
//   - Wave lanes (Loop.h / TransitionSample.h): the Loop track (one clip per
//     present segment, full segment range) and the shared "Sample Transitions FX"
//     track (placed per arrangement[seg].transitions). Sample-ID -> asset is
//     playsample-{id}.ogg (SamplesDownloadTask.h). Duplicate instrument ids are
//     deduped (first wins) as CasperakiEngine.cpp::addInstrument does.
//
//   - Guitar lanes (Guitar.h): the Guitar instrument -> four tracks
//     (short/long tonal notes, fret noises, virtualGuitarist strums). Pitch/
//     timing exact; strum + fret velocity exact; short/long tonal velocity is
//     VelocityMode::randomised (validated to a band — see Guitar.h).
//
//   - Transition-pattern lanes (TransitionPattern.h): the EDM snare roll — one
//     step track per transitionPattern instrument, one step clip per segment
//     whose arrangement[seg].transitions carries the instrument's id.
//
// arpeggio / EDMArpeggiator are ported in Tonal.h (buildTonalNotes; Guitar.h
// too). No fixture exercises them, so they are checked by hand-derived exact
// expectations in test/arpeggio_test.cpp rather than the oracle (PORTING-MAP.md
// step 4).
#pragma once

#include "ResolvedEvents.h"
#include "Random.h"
#include "Tonal.h"
#include "Guitar.h"
#include "Drums.h"
#include "../vendor/json.hpp"

#include <algorithm>
#include <array>
#include <map>
#include <memory>
#include <set>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace casperaki {

using nlohmann::json;

class Resolver {
public:
    // `songJson` is the song.json text; `instJsons` are the inst-N.json texts in
    // ascending id order (as the native harness adds them, harness.cpp:127-145).
    ResolvedEvents resolve(const std::string& songJson,
                           const std::vector<std::string>& instJsons) {
        ResolvedEvents out;
        song_ = json::parse(songJson);
        songText_ = &songJson;
        songOrdered_.reset();

        out.genre = song_.value("genre", std::string());

        // Deterministic humanization seed from the canonical song bytes
        // (docs/61 §2 preferred path). Owned per-resolve so the velocity grid is
        // reproducible run-to-run for a given song.
        rng_.setSeed(Random::seedFromString(songJson));

        // --- Structure/timeline math (Sequencer.cpp:386,436-442) -------------
        // 4/4 throughout, a single tempo inserted at beat 0; segments are laid
        // end to end. Each bar is BEATS_PER_BAR beats; beats convert to seconds
        // at 60/tempo. The edit length is the sum of all segment bar counts.
        const double tempo = song_.value("tempo", 120.0);
        secPerBeat_ = 60.0 / tempo;
        out.secPerBeat = secPerBeat_;

        buildSegments();
        int totalBars = 0;
        for (const auto& s : segments_) totalBars += s.numBars;
        out.lengthSec = totalBars * BEATS_PER_BAR * secPerBeat_;

        // --- Per-lane resolution ---------------------------------------------
        std::vector<Inst> insts = parseInstruments(instJsons);
        for (const auto& inst : insts) {
            if      (inst.type == "drums")            resolveDrumInstrument(inst, out);
            else if (inst.type == "percussionLoops")  resolveLoopInstrument(inst, out);
            else if (inst.type == "transitionSample") { /* shared track, below */ }
            else if (inst.type == "transitionPattern") resolveTransitionPatternInstrument(inst, out);
            else if (inst.type == "electricGuitars" ||
                     inst.type == "acousticGuitars")  resolveGuitarInstrument(inst, out);
            else                                      resolveTonalInstrument(inst, out);
        }
        // TransitionSample clips share ONE "Sample Transitions FX" track
        // (Sequencer.cpp:457 routes every transitionSample to sampleTransitionsTrackFX),
        // so they cannot be emitted per-instrument like the lanes above. Build the
        // shared track in the native segment-outer / instrument-inner order.
        resolveTransitionSamples(insts, out);

        // Scope D — per-instrument signalProcessors automation (Instrument.cpp:28).
        resolveAutomation(insts, out);

        // docs/62 A7 — fxNoiseRise transition risers (transitionNoise).
        resolveNoiseRises(out);

        songText_ = nullptr;
        songOrdered_.reset();
        return out;
    }

    static constexpr double BEATS_PER_BAR = 4.0;

private:
    struct Inst {
        int id = 0;
        std::string name, type, lowLevelType;
        int octaveAdjustment = 0;
        json data;
    };
    struct Segment {
        std::string name;
        const json* bars = nullptr; // structure[i].bars — the chord grid
        int numBars = 0;
        double startBeat = 0;
    };

    json song_;
    // The song text and an insertion-ordered parse of it, built on first use.
    // nlohmann::json sorts object keys; a transition pattern's channels follow the
    // JSON object's key ORDER (juce::DynamicObject keeps insertion order), so the
    // pattern object is read from this ordered parse.
    const std::string* songText_ = nullptr;
    std::unique_ptr<nlohmann::ordered_json> songOrdered_;
    Random rng_;
    double secPerBeat_ = 0.5;
    std::vector<Segment> segments_;

    void buildSegments() {
        segments_.clear();
        double accBeats = 0;
        if (!song_.contains("structure")) return;
        for (const auto& seg : song_.at("structure")) {
            Segment s;
            s.name = seg.value("segment", std::string());
            if (seg.contains("bars") && seg.at("bars").is_array()) {
                s.bars = &seg.at("bars");
                s.numBars = (int)seg.at("bars").size();
            }
            s.startBeat = accBeats;
            accBeats += s.numBars * BEATS_PER_BAR;
            segments_.push_back(s);
        }
    }

    std::vector<Inst> parseInstruments(const std::vector<std::string>& instJsons) {
        std::vector<Inst> insts;
        std::set<int> seenIds;
        for (const auto& txt : instJsons) {
            json d = json::parse(txt);
            // CasperakiEngine.cpp:449-460 — addInstrument skips an instrument whose
            // id already exists (first wins). The fixtures ship two id-50000 Loop
            // instruments (inst-13/14); without this the second would emit a second
            // "Loop" track. instJsons arrive in ascending inst-file order = add order.
            const int id = d.value("id", 0);
            if (!seenIds.insert(id).second) continue;
            Inst inst;
            inst.id = id;
            inst.name = d.value("name", std::string());
            inst.type = d.value("type", std::string());
            inst.lowLevelType = d.value("lowLevelType", std::string());
            if (d.contains("details") && d.at("details").contains("octaveAdjustment"))
                inst.octaveAdjustment = (int)d.at("details").at("octaveAdjustment").get<double>();
            inst.data = std::move(d);
            insts.push_back(std::move(inst));
        }
        return insts;
    }

    // Scope D — emit per-instrument automation from arrangement[seg].signalProcessors
    // (Instrument::applySignalProcessor). lowPassFilter steps -> cutoff-Hz curve;
    // volume steps -> dB curve. Absolute song seconds; sparse (break/buildup risers).
    void resolveAutomation(const std::vector<Inst>& insts, ResolvedEvents& out) {
        for (const auto& inst : insts) {
            AutoLane lane;
            lane.instName = inst.name;
            for (const auto& seg : segments_) {
                const json* sp = arrangementData(seg.name, "signalProcessors", inst.name);
                if (!sp || !sp->is_object()) continue;
                const double segStart = seg.startBeat * secPerBeat_;
                // Mirror Instrument.cpp:63-71 EXACTLY: bracket the steps with open
                // (30000 Hz) anchors at curve 0, and tag each step with curve 0.5
                // (the Tracktion bezier the cutoff sweep rides — not linear).
                if (sp->contains("lowPassFilter") && sp->at("lowPassFilter").is_array()
                    && !sp->at("lowPassFilter").empty()) {
                    lane.lowPass.push_back({segStart, 30000.0, 0.0});            // :63 open anchor
                    double lastT = segStart;
                    for (const auto& step : sp->at("lowPassFilter")) {
                        lastT = segStart + step.value("pointInSeconds", 0.0);
                        lane.lowPass.push_back({lastT, step.value("value", 30000.0), 0.5});  // :68
                    }
                    lane.lowPass.push_back({lastT, 30000.0, 0.0});              // :71 close anchor
                }
                if (sp->contains("volume") && sp->at("volume").is_array())
                    for (const auto& step : sp->at("volume"))
                        lane.volume.push_back({segStart + step.value("pointInSeconds", 0.0),
                                               step.value("value", 0.0)});
            }
            if (!lane.lowPass.empty() || !lane.volume.empty()) out.automation.push_back(std::move(lane));
        }
    }

    // docs/62 A7 — turn each fxNoiseRise transition (expanded by the adapter into
    // the legacy EffectsClass param object) into an absolute-time NoiseRise. The
    // transition block is keyed by an arbitrary name, so we scan for type matches.
    void resolveNoiseRises(ResolvedEvents& out) {
        if (!song_.contains("arrangement")) return;
        const json& a = song_.at("arrangement");
        for (const auto& seg : segments_) {
            auto sit = a.find(seg.name);
            if (sit == a.end()) continue;
            auto tit = sit->find("transitions");
            if (tit == sit->end() || !tit->is_object()) continue;
            const double segStart = seg.startBeat * secPerBeat_;
            for (auto it = tit->begin(); it != tit->end(); ++it) {
                const json& t = it.value();
                if (!t.is_object() || t.value("type", std::string()) != "fxNoiseRise") continue;
                NoiseRise nr;
                // sequenceStartPosition is in 32nd notes; 8 per beat (TransitionNoise.h:35).
                const double ssp = t.value("sequenceStartPosition", 0.0);
                const double off = t.value("sequenceStartPositionOffsetInSeconds", 0.0);
                nr.startSec = segStart + (ssp / 8.0) * secPerBeat_ + off;
                nr.attackDuration = t.value("attackDuration", 0.0);
                nr.decayOffset =
                    t.value("decaySequenceStartPositionOffsetInSeconds", nr.attackDuration);
                nr.decayDuration = t.value("decayDuration", 0.0);
                nr.freqStart = t.value("frequencyStart", 100.0);
                nr.freqEnd = t.value("frequencyEnd", 20000.0);
                nr.volAttack = t.value("volumeAttack", -30.0);
                nr.volSustain = t.value("volumeSustain", -20.0);
                nr.volDecay = t.value("volumeDecay", -50.0);
                out.noiseRises.push_back(nr);
            }
        }
    }

    static bool isSynthsClass(const std::string& type) {
        return type == "leadSynths" || type == "synths" || type == "keys" ||
               type == "popBrass" || type == "popStrings" || type == "orchestral" ||
               type == "vocals";
    }

    // Instrument.h:121-146 — walk arrangement[seg][dataName][instName].
    const json* arrangementData(const std::string& segName, const std::string& dataName,
                                const std::string& instName) const {
        if (!song_.contains("arrangement")) return nullptr;
        const json& a = song_.at("arrangement");
        auto sit = a.find(segName);  if (sit == a.end()) return nullptr;
        auto dit = sit->find(dataName); if (dit == sit->end()) return nullptr;
        auto iit = dit->find(instName); if (iit == dit->end()) return nullptr;
        return &(*iit);
    }
    // Instrument.h:152-155 — default present when unspecified.
    bool isInstrumentInSegment(const std::string& segName, const std::string& instName) const {
        const json* p = arrangementData(segName, "instruments", instName);
        if (!p) return true;
        return p->is_boolean() ? p->get<bool>() : true;
    }

    // Sequencer.cpp:51-96 getTransitionSegmentData — arrangement[seg].transitions
    // is keyed by arbitrary names; the active one is the entry whose `id` matches
    // the instrument. Returns the transition object (carries sequenceStartPosition
    // + offset) or nullptr when this instrument has no transition in this segment.
    // The id is the numeric `id` when present, else 100000 + `transitionId`
    // (Sequencer.cpp:81-86 — the legacy transitionPattern encoding; the engine
    // adapter writes a numeric `id`). The fxNoiseRise string id is handled by
    // resolveNoiseRises. `keyOut`, when given, receives the transition's key.
    const json* getTransitionData(const std::string& segName, int id,
                                  std::string* keyOut = nullptr) const {
        if (!song_.contains("arrangement")) return nullptr;
        const json& a = song_.at("arrangement");
        auto sit = a.find(segName); if (sit == a.end()) return nullptr;
        auto tit = sit->find("transitions");
        if (tit == sit->end() || !tit->is_object()) return nullptr;
        for (auto it = tit->begin(); it != tit->end(); ++it) {
            const json& obj = it.value();
            if (!obj.is_object()) continue;
            int objId;
            if (obj.contains("id") && obj.at("id").is_number())
                objId = (int)obj.at("id").get<double>();
            else if (!obj.contains("id") && obj.contains("transitionId") && obj.at("transitionId").is_number())
                objId = 100000 + (int)obj.at("transitionId").get<double>();
            else
                continue;
            if (objId == id) {
                if (keyOut) *keyOut = it.key();
                return &it.value();
            }
        }
        return nullptr;
    }

    // SequencerUtils.h:75-103 — patterns[0].pattern[] matched by instrumentId.
    const json* getInstrumentPattern(int id) const {
        if (!song_.contains("patterns")) return nullptr;
        const json& patterns = song_.at("patterns");
        if (!patterns.is_array() || patterns.empty()) return nullptr;
        const json& first = patterns[0];
        if (!first.contains("pattern")) return nullptr;
        for (const auto& p : first.at("pattern"))
            if (p.contains("instrumentId") && (int)p.at("instrumentId").get<double>() == id)
                return &p;
        return nullptr;
    }

    // TonalInstrument.h:36-247 + Synths.h/Bass.h createSegmentClip. Walks every
    // segment, builds notes, and lands clips on the instrument's track(s).
    void resolveTonalInstrument(const Inst& inst, ResolvedEvents& out) {
        const bool isBass = inst.type == "basses";
        if (!isBass && !isSynthsClass(inst.type)) return;

        const json* pattern = getInstrumentPattern(inst.id);
        if (!pattern) return; // Sequencer skips an instrument with no pattern

        Chord songKey{song_.value("key", std::string("C"))};

        // One track for Synths-class; Bass splits into long/short note tracks.
        Track synthsTrack; synthsTrack.name = inst.name;
        Track bassLong;  bassLong.name  = inst.name + "(long notes)";
        Track bassShort; bassShort.name = inst.name + "(short notes)";

        for (const auto& seg : segments_) {
            if (!seg.bars) continue;
            if (!isInstrumentInSegment(seg.name, inst.name)) continue;

            // Override (if present) replaces the pattern for this segment.
            const json* overrideData = arrangementData(seg.name, "overrides", inst.name);
            const json& effective = (overrideData && overrideData->is_object()) ? *overrideData : *pattern;
            if (!effective.contains("bars") || !effective.at("bars").is_array()) continue;

            bool isScalePentatonic = effective.contains("scale") &&
                                     asStr(effective.at("scale")) == "pentatonic";

            std::vector<TimeNote> notes = buildTonalNotes(
                effective.at("bars"), *seg.bars, songKey, inst.octaveAdjustment, isScalePentatonic);

            double startSec = seg.startBeat * secPerBeat_;
            double endSec = startSec + seg.numBars * BEATS_PER_BAR * secPerBeat_;

            if (isBass) emitBassClips(bassLong, bassShort, seg.name, startSec, endSec, notes);
            else        emitSynthsClip(synthsTrack, seg.name, startSec, endSec, notes);
        }

        if (isBass) { out.tracks.push_back(std::move(bassLong)); out.tracks.push_back(std::move(bassShort)); }
        else        { out.tracks.push_back(std::move(synthsTrack)); }
    }

    // Default note te gives a freshly inserted StepClip channel
    // (tracktion_StepClip.cpp:496 IDs::note=defaultNoteNumber). Strum step clips
    // pad skipped channel slots with this — see resolveGuitarInstrument.
    static constexpr int kStepDefaultNote = 60;

    // Guitar.h createSegmentClip + TonalInstrument::processSegment — resolve the
    // Guitar instrument (electric/acoustic) into four tracks: short/long tonal
    // notes (VelocityMode::randomised), fret noises (data velocity), and strums
    // (virtualGuitarist — a midi clip of strum notes + a channel-only step clip).
    // See Guitar.h for the per-track velocity-parity policy.
    void resolveGuitarInstrument(const Inst& inst, ResolvedEvents& out) {
        const json* pattern = getInstrumentPattern(inst.id);
        if (!pattern) return; // Sequencer skips an instrument with no pattern

        Chord songKey{song_.value("key", std::string("C"))};
        const double bpm = song_.value("tempo", 120.0);
        const bool isAcoustic = inst.lowLevelType.rfind("acoustic", 0) == 0;

        Track shortTrack;  shortTrack.name  = inst.name + "(short notes)";
        Track longTrack;   longTrack.name   = inst.name + "(long notes)";
        Track fretTrack;   fretTrack.name   = inst.name + "(fret noises)";
        Track strumsTrack; strumsTrack.name = inst.name + "(strums)";

        // Per-instrument strum sample -> sound index (Guitar.h getPluginSoundIndex:
        // first GLOBAL appearance across segments assigns the next index; the
        // sampler note number = index + 48).
        std::map<std::string, int> keyToIndex;

        // The strum sample keys this instrument actually ships
        // (instrumentData["virtualGuitaristSamples"]). ensureSampleMidiNote
        // (Guitar.h:329-379) throws when a strum's key has no matching sample —
        // and that throw is caught per (instrument, segment) in
        // Sequencer.cpp:473-477, so it ABORTS the rest of THIS segment's strum
        // loop while keeping the strums already emitted. The fixtures only ship a
        // narrow set (e.g. brightPop: four chordShortStrumDown chords), so most
        // patterns lose every strum after their first un-shipped type/chord.
        std::set<std::string> availKeys;
        if (inst.data.contains("virtualGuitaristSamples")) {
            for (const auto& s : inst.data.at("virtualGuitaristSamples")) {
                if (s.contains("fx") && s.at("fx").is_string() && !s.at("fx").get<std::string>().empty())
                    availKeys.insert(s.at("fx").get<std::string>());
                else if (s.contains("chord"))
                    availKeys.insert(asStr(s.at("chord")) + "_" +
                                     std::to_string(asInt(s.value("chordPosition", json(1)))) + "_" +
                                     asStr(s.value("type", json(""))));
            }
        }

        for (const auto& seg : segments_) {
            if (!seg.bars) continue;
            if (!isInstrumentInSegment(seg.name, inst.name)) continue;

            const json* overrideData = arrangementData(seg.name, "overrides", inst.name);
            const json& effective = (overrideData && overrideData->is_object()) ? *overrideData : *pattern;
            if (!effective.contains("bars") || !effective.at("bars").is_array()) continue;

            bool isScalePentatonic = effective.contains("scale") &&
                                     asStr(effective.at("scale")) == "pentatonic";

            GuitarSegmentNotes sn = buildGuitarSegment(
                effective.at("bars"), *seg.bars, songKey, inst.octaveAdjustment,
                isScalePentatonic, bpm, isAcoustic);

            // Negative-time stretch (TonalInstrument.h:195-239): if any note/strum
            // starts before the segment, the clip start moves earlier and every
            // note/strum shifts so the earliest lands at beat 0; endSec is kept.
            double stretchStart = 0;
            for (const auto& n : sn.timeNotes)  if (n.start < -stretchStart) stretchStart = -n.start;
            for (const auto& s : sn.timeStrums) if (s.start < -stretchStart) stretchStart = -s.start;
            if (stretchStart != 0) {
                for (auto& n : sn.timeNotes)  n.start += stretchStart;
                for (auto& s : sn.timeStrums) s.start += stretchStart;
            }

            double startSec = (seg.startBeat - stretchStart) * secPerBeat_;
            double endSec = (seg.startBeat + seg.numBars * BEATS_PER_BAR) * secPerBeat_;

            // --- short / long / fret (only when there are tonal/fret notes) ----
            if (!sn.timeNotes.empty()) {
                Clip sC; sC.name = seg.name; sC.type = "midi"; sC.startSec = startSec; sC.endSec = endSec;
                Clip lC; lC.name = seg.name; lC.type = "midi"; lC.startSec = startSec; lC.endSec = endSec;
                Clip fC; fC.name = seg.name; fC.type = "midi"; fC.startSec = startSec; fC.endSec = endSec;
                for (const auto& tn : sn.timeNotes) {
                    if (tn.kind == TimeNote::ntFretNoise)
                        // fretNoisesSequence->addNote — raw, no shortener / no RNG.
                        fC.notes.push_back(Note{tn.note.midiNote, tn.note.toString(),
                                                tn.start, tn.duration, tn.velocity});
                    else if (tn.duration > 0.5) addNoteToClip(lC, tn, vmRandomised, &rng_);
                    else                        addNoteToClip(sC, tn, vmRandomised, &rng_);
                }
                sortClipNotes(sC); sortClipNotes(lC); sortClipNotes(fC);
                shortTrack.clips.push_back(std::move(sC));
                longTrack.clips.push_back(std::move(lC));
                fretTrack.clips.push_back(std::move(fC));
            }

            // --- strums (a midi clip + a channel-only step clip) ---------------
            if (!sn.timeStrums.empty()) {
                Clip midi; midi.name = seg.name; midi.type = "midi"; midi.startSec = startSec; midi.endSec = endSec;
                Clip step; step.name = seg.name; step.type = "step"; step.startSec = startSec; step.endSec = endSec;

                for (const auto& strum : sn.timeStrums) {
                    std::string skey = strumSampleKey(strum);
                    auto it = keyToIndex.find(skey);
                    int soundIndex;
                    if (it != keyToIndex.end()) {
                        soundIndex = it->second; // already loaded — no re-check
                    } else if (availKeys.count(skey)) {
                        soundIndex = keyToIndex[skey] = (int)keyToIndex.size();
                    } else {
                        break; // ensureSampleMidiNote throws -> segment strum loop aborts
                    }
                    int keyNote = soundIndex + 48;

                    // ensureSampleMidiNote + StepClip::insertNewChannel: a slot is
                    // set real only the first time it is reached as a NEW maximum;
                    // insertNewChannel appends, padding intermediate slots with the
                    // (60,"") default. A slot already padded by a larger earlier
                    // index stays default. So only grow when soundIndex is new-max.
                    if (soundIndex >= (int)step.channels.size()) {
                        while ((int)step.channels.size() < soundIndex)
                            step.channels.push_back(StepChannel{kStepDefaultNote, ""});
                        step.channels.push_back(StepChannel{keyNote, skey});
                    }

                    // duration != -1 always holds after the segment offset, so every
                    // strum lands as a midi note (the step/fx setNote branch is dead).
                    if (strum.duration != -1)
                        midi.notes.push_back(Note{keyNote, music::Note{keyNote}.toString(),
                                                  strum.start, strum.duration, strum.velocity});
                }

                // numSteps = 8 * (int)(stretched length in beats) (Guitar.h:110-111).
                int beats = (int)((double)seg.numBars * BEATS_PER_BAR + stretchStart);
                StepPattern sp; sp.name = ""; sp.numSteps = 8 * beats;
                step.patterns.push_back(std::move(sp));

                sortClipNotes(midi);
                strumsTrack.clips.push_back(std::move(midi));
                strumsTrack.clips.push_back(std::move(step));
            }
        }

        // te skips silent/empty tracks in the dump (harness.cpp:466).
        if (!shortTrack.clips.empty())  out.tracks.push_back(std::move(shortTrack));
        if (!longTrack.clips.empty())   out.tracks.push_back(std::move(longTrack));
        if (!fretTrack.clips.empty())   out.tracks.push_back(std::move(fretTrack));
        if (!strumsTrack.clips.empty()) out.tracks.push_back(std::move(strumsTrack));
    }

    // Drums.h processSegment + createSegmentClip — resolve the drum instrument
    // into four step tracks. For each segment: build the four step clips, apply
    // the base pattern (group-filtered by override.type unless override.reset
    // replaces it), then overlay fills. Channels are the sampler sounds, one per
    // sub-instrument routed to that group; the channel's note is 48+idsIndex*2
    // (Drums.h::getSampleNoteNumber). The native sampler's channel ORDER is
    // std::unordered_map hash order (non-portable), so we emit channels in `ids`
    // order and the validator matches hits by (note,step), not raw channel index.
    void resolveDrumInstrument(const Inst& inst, ResolvedEvents& out) {
        const json* pattern = getInstrumentPattern(inst.id);
        if (!pattern) return; // Sequencer skips an instrument with no pattern

        const json ids  = inst.data.value("ids", json::object());
        const json subs = inst.data.value("subInstruments", json::object());

        // ids index -> sampler note number. nlohmann sorts keys; the fixtures'
        // `ids` are already alphabetical so this matches juce's insertion order.
        // (A mismatch would surface as a wrong channel note in the diff.)
        std::map<std::string, int> idsIndex;
        { int i = 0; for (auto it = ids.begin(); it != ids.end(); ++it) idsIndex[it.key()] = i++; }

        // Per-group channel lists + name -> local-channel-index lookup.
        std::array<std::vector<StepChannel>, 4> groupChannels;
        std::array<std::map<std::string, int>, 4> groupChanIdx;
        for (auto it = ids.begin(); it != ids.end(); ++it) {
            const std::string name = it.key();
            std::string ig = subs.contains(name)
                ? subs.at(name).value("instrumentGroup", std::string()) : std::string();
            DrumGroup g = drumGroupFor(ig);
            int note = 48 + idsIndex[name] * 2;
            groupChanIdx[g][name] = (int)groupChannels[g].size();
            groupChannels[g].push_back(StepChannel{note, name});
        }

        Track tracks[4];
        tracks[dgKicks].name  = inst.name + "-kicks";
        tracks[dgSnares].name = inst.name + "-snares";
        tracks[dgToms].name   = inst.name + "-toms";
        tracks[dgRest].name   = inst.name + "-rest";

        for (const auto& seg : segments_) {
            if (!isInstrumentInSegment(seg.name, inst.name)) continue;
            const int barsCount = seg.numBars;
            const int numSteps = 32 * barsCount;
            const double startSec = seg.startBeat * secPerBeat_;
            const double endSec = startSec + barsCount * BEATS_PER_BAR * secPerBeat_;

            // Final note state per group, keyed (localChannel, absStep) -> velocity.
            std::array<std::map<std::pair<int, int>, int>, 4> hitMaps;

            // Drums.h::applyPattern — tile each sub-instrument's grid across
            // [startBar,endBar), routing to its group's clip and applying setNote
            // semantics ('x' sets, '0' clears) into hitMaps.
            auto applyDrumPattern = [&](const json& patternObj, int startBar, int endBar,
                                        DrumOverrideType ot) {
                if (!patternObj.contains("pattern") || !patternObj.at("pattern").is_object()) return;
                const json& pp = patternObj.at("pattern");
                int pbc = drumPatternBarsCount(patternObj);
                if (pbc <= 0) return;
                for (auto it = pp.begin(); it != pp.end(); ++it) {
                    const std::string name = it.key();
                    if (!drumOverridePasses(ot, name)) continue;
                    std::string ig = subs.contains(name)
                        ? subs.at(name).value("instrumentGroup", std::string()) : std::string();
                    DrumGroup g = drumGroupFor(ig);
                    auto ci = groupChanIdx[g].find(name);
                    if (ci == groupChanIdx[g].end()) continue; // no sampler channel
                    const int ch = ci->second;
                    const std::string s = retainStepChars(asStr(it.value()));
                    for (int currentBar = startBar; currentBar < endBar; currentBar += pbc) {
                        for (int i = 0; i < (int)s.size(); ++i) {
                            const int step = currentBar * 32 + i;
                            if (step < 0 || step >= numSteps) continue;
                            if (s[i] == 'x')      hitMaps[g][{ch, step}] = 127;
                            else if (s[i] == '0') hitMaps[g].erase({ch, step});
                        }
                    }
                }
            };

            // Drums.h::applyFill — place a fill pattern at a bar offset.
            auto applyDrumFill = [&](const json& fillObj, DrumFillType ft) {
                int pbc = drumPatternBarsCount(fillObj);
                if (pbc == 0) return;
                int startBar = 0;
                if      (ft == dfFourthBar)   { if (barsCount < 16) return; startBar = 3; }
                else if (ft == dfTwelfthBar)  { if (barsCount < 16) return; startBar = 11; }
                else if (ft == dfMiddle)      { if (barsCount < 8)  return; startBar = barsCount / 2 - 1; }
                else if (ft == dfEndOfSegment) { startBar = barsCount - pbc - 1; }
                applyDrumPattern(fillObj, startBar, startBar + pbc, doAll);
            };

            // Drums.h::createSegmentClip:329-353 — base/override pattern, then fills.
            const json* override = arrangementData(seg.name, "overrides", inst.name);
            const bool resetTrue = override && override->is_object() &&
                override->contains("reset") && override->at("reset").is_boolean() &&
                override->at("reset").get<bool>();
            if (resetTrue) {
                applyDrumPattern(*override, 0, barsCount, doAll);
            } else {
                DrumOverrideType ot = doAll;
                if (override && override->is_object() && override->contains("type") &&
                    override->at("type").is_string())
                    ot = drumOverrideTypeFromString(override->at("type").get<std::string>());
                applyDrumPattern(*pattern, 0, barsCount, ot);
            }

            const json* fill = arrangementData(seg.name, "fills", inst.name);
            if (fill && fill->is_object() && fill->contains("patterns") &&
                fill->at("patterns").is_object()) {
                for (auto it = fill->at("patterns").begin(); it != fill->at("patterns").end(); ++it) {
                    json fillObj; fillObj["pattern"] = it.value();
                    applyDrumFill(fillObj, drumFillTypeFromString(it.key()));
                }
            }

            // Materialise the four step clips (one per group, even when empty —
            // te always inserts a StepClip per segment per track).
            for (int g = 0; g < 4; ++g) {
                Clip clip; clip.name = seg.name; clip.type = "step";
                clip.startSec = startSec; clip.endSec = endSec;
                clip.channels = groupChannels[g];
                StepPattern sp; sp.name = ""; sp.numSteps = numSteps;
                for (const auto& kv : hitMaps[g])
                    sp.hits.push_back(StepHit{kv.first.first, kv.first.second, kv.second});
                clip.patterns.push_back(std::move(sp));
                tracks[g].clips.push_back(std::move(clip));
            }
        }

        for (int g = 0; g < 4; ++g) out.tracks.push_back(std::move(tracks[g]));
    }

    // Loop.h processSegment + createSegmentClip — one wave clip per present
    // segment, spanning the FULL segment time range (te tiles the source N=ceil
    // times internally, but the dumped clip is just name + segment range + source).
    // The asset is the playsample for this instrument id (SamplesDownloadTask.h:
    // URL {base}/playsample/playsample-{id}; file name playsample-{id}.ogg).
    void resolveLoopInstrument(const Inst& inst, ResolvedEvents& out) {
        Track track; track.name = inst.name;
        for (const auto& seg : segments_) {
            if (!isInstrumentInSegment(seg.name, inst.name)) continue;
            Clip c; c.name = seg.name; c.type = "wave";
            c.startSec = seg.startBeat * secPerBeat_;
            c.endSec = c.startSec + seg.numBars * BEATS_PER_BAR * secPerBeat_;
            c.source = sampleSource(inst.id);
            c.loop = true;
            track.clips.push_back(std::move(c));
        }
        // te skips silent/empty tracks in the dump (harness.cpp:466) — so do we.
        if (!track.clips.empty()) out.tracks.push_back(std::move(track));
    }

    // TransitionSample.h processSegment — every transitionSample lands on the
    // single shared "Sample Transitions FX" track (Sequencer.cpp:457). A clip is
    // placed only where arrangement[seg].transitions carries this instrument's id.
    // Placement (TransitionSample.h:57-70): start = segStart + toTime(ssp/8) +
    // offsetSec, length = details.duration. toTime(beats) = beats*secPerBeat under
    // the single tempo. Built segment-outer / instrument-inner to mirror the native
    // insertion order (Sequencer.cpp:409-486).
    void resolveTransitionSamples(const std::vector<Inst>& insts, ResolvedEvents& out) {
        Track track; track.name = "Sample Transitions FX";
        for (const auto& seg : segments_) {
            for (const auto& inst : insts) {
                if (inst.type != "transitionSample") continue;
                if (!isInstrumentInSegment(seg.name, inst.name)) continue;
                const json* td = getTransitionData(seg.name, inst.id);
                if (!td) continue;
                double duration = 0.0;
                if (inst.data.contains("details") && inst.data.at("details").contains("duration"))
                    duration = inst.data.at("details").at("duration").get<double>();
                double ssp = td->value("sequenceStartPosition", 0.0);
                double off = td->value("sequenceStartPositionOffsetInSeconds", 0.0);
                double startSec = seg.startBeat * secPerBeat_
                                + (ssp / 8.0) * secPerBeat_ + off;
                Clip c; c.name = seg.name; c.type = "wave";
                c.startSec = startSec; c.endSec = startSec + duration;
                c.source = sampleSource(inst.id);
                c.loop = false;
                // Each transition has its own target volume (cymbalsCrashHit 0 dB,
                // fxLowImpact/fxUplifter -10 dB, ...) — carry the lowLevelType so the
                // mixer applies a PER-CLIP gain (the FX lane mixes several transitions
                // with different volumes through one source track).
                c.lowLevel = inst.lowLevelType;
                track.clips.push_back(std::move(c));
            }
        }
        if (!track.clips.empty()) out.tracks.push_back(std::move(track));
    }

    // TransitionPattern.h (casperaki_engine 90dc0f4) processSegment +
    // createSegmentClip — the EDM snare roll. One track named after the
    // instrument; per segment whose arrangement[seg].transitions carries this
    // instrument's id, one step clip:
    //   start = toTime(segStartBeat + sequenceStartPosition/8 beats)
    //           + sequenceStartPositionOffsetInSeconds,
    //   length = barsCount*4 beats, barsCount = len(first channel string, keeping
    //   only '0'/'x') / 32 (integer division; 0 -> no clip),
    //   32*barsCount steps of 1/8 beat; 'x' at index i of pattern channel c (c =
    //   position in the JSON object's key order) -> a hit on step-clip channel c,
    //   step i, velocity 127 (te::StepClip::Pattern::setNote drops i >= numNotes).
    // Step-clip channels are the sampler's sounds (prepareClip): channel c plays
    // samples[c] at note getMidiNoteNumber(samples[c].note), named by the note.
    // Legacy built that sound list from a std::unordered_map (FileMap), so its
    // channel order was the hash order (on libstdc++ {"C1","G1"} iterates G1, C1);
    // the port uses samples[] order, the engine adapter's contract
    // (packages/engine-adapter/src/transitions.ts: channel i plays samples[i]).
    void resolveTransitionPatternInstrument(const Inst& inst, ResolvedEvents& out) {
        const std::string where = "transitionPattern instrument '" + inst.name + "'";
        if (!inst.data.contains("samples") || !inst.data.at("samples").is_array()
            || inst.data.at("samples").empty())
            throw std::runtime_error(where + ": missing or empty `samples` array");
        std::vector<StepChannel> channels;
        for (const auto& smp : inst.data.at("samples")) {
            if (!smp.contains("note") || !smp.at("note").is_string())
                throw std::runtime_error(where + ": a `samples[]` entry has no string `note`");
            const std::string note = smp.at("note").get<std::string>();
            channels.push_back(StepChannel{music::getMidiNoteNumber(note), note});
        }

        Track track;
        track.name = inst.name;
        for (const auto& seg : segments_) {
            if (!isInstrumentInSegment(seg.name, inst.name)) continue;
            std::string key;
            const json* td = getTransitionData(seg.name, inst.id, &key);
            if (!td) continue;
            const std::string at = where + ", segment '" + seg.name + "', transition '" + key + "'";
            if (!td->contains("sequenceStartPosition") || !td->at("sequenceStartPosition").is_number())
                throw std::runtime_error(at + ": missing numeric `sequenceStartPosition`");
            if (!td->contains("sequenceStartPositionOffsetInSeconds")
                || !td->at("sequenceStartPositionOffsetInSeconds").is_number())
                throw std::runtime_error(at + ": missing numeric `sequenceStartPositionOffsetInSeconds`");

            const nlohmann::ordered_json& otd =
                orderedSong().at("arrangement").at(seg.name).at("transitions").at(key);
            if (!otd.contains("config") || !otd.at("config").contains("details")
                || !otd.at("config").at("details").contains("pattern")
                || !otd.at("config").at("details").at("pattern").is_object())
                throw std::runtime_error(at + ": missing object `config.details.pattern`");
            const nlohmann::ordered_json& pattern = otd.at("config").at("details").at("pattern");
            if (pattern.empty()) continue;  // getPatternBarsCount -> 0: no clip
            if (pattern.size() > channels.size())
                throw std::runtime_error(at + ": pattern has " + std::to_string(pattern.size())
                                         + " channels but the instrument has only "
                                         + std::to_string(channels.size()) + " samples");

            std::vector<std::string> grids;
            for (auto it = pattern.begin(); it != pattern.end(); ++it) {
                if (!it.value().is_string())
                    throw std::runtime_error(at + ": pattern channel '" + it.key() + "' is not a string");
                grids.push_back(retainPatternStepChars(it.value().get<std::string>()));
            }
            const int barsCount = (int)grids.front().size() / 32;
            if (barsCount == 0) continue;
            const int numSteps = 32 * barsCount;

            // (int) cast of sequenceStartPosition mirrors `(int) transitionData[...] / 8.0`.
            const double ssp = (double)(int)td->at("sequenceStartPosition").get<double>();
            const double off = td->at("sequenceStartPositionOffsetInSeconds").get<double>();
            Clip c; c.name = seg.name; c.type = "step";
            c.startSec = (seg.startBeat + ssp / 8.0) * secPerBeat_ + off;
            c.endSec = c.startSec + barsCount * BEATS_PER_BAR * secPerBeat_;
            c.channels = channels;
            StepPattern p; p.numSteps = numSteps;
            for (int ci = 0; ci < (int)grids.size(); ++ci)
                for (int i = 0; i < (int)grids[(size_t)ci].size() && i < numSteps; ++i)
                    if (grids[(size_t)ci][(size_t)i] == 'x') p.hits.push_back(StepHit{ci, i, 127});
            c.patterns.push_back(std::move(p));
            track.clips.push_back(std::move(c));
        }
        if (!track.clips.empty()) out.tracks.push_back(std::move(track));
    }

    const nlohmann::ordered_json& orderedSong() {
        if (!songOrdered_) {
            if (!songText_) throw std::logic_error("Resolver: song text not set (orderedSong outside resolve)");
            songOrdered_ = std::make_unique<nlohmann::ordered_json>(nlohmann::ordered_json::parse(*songText_));
        }
        return *songOrdered_;
    }

    // SamplesDownloadTask.h downloadSamples — assets are named playsample-{id}.ogg.
    static std::string sampleSource(int id) {
        return "playsample-" + std::to_string(id) + ".ogg";
    }

    // Synths.h:56-80 — every note gets +SUSTAIN_TAIL_BEATS, VelocityMode::beat.
    void emitSynthsClip(Track& track, const std::string& segName,
                        double startSec, double endSec, const std::vector<TimeNote>& notes) {
        static constexpr double SUSTAIN_TAIL_BEATS = 2.0;
        Clip clip; clip.name = segName; clip.type = "midi";
        clip.startSec = startSec; clip.endSec = endSec;
        for (const auto& tn : notes) {
            TimeNote sustained = tn;
            sustained.duration += SUSTAIN_TAIL_BEATS;
            addNoteToClip(clip, sustained, vmBeat);
        }
        sortClipNotes(clip);
        track.clips.push_back(std::move(clip));
    }

    // Bass.h:32-72 — long notes (dur>0.5) get the sustain tail and land on the
    // long track; short notes land staccato on the short track. Both clips are
    // created per segment (even when empty), matching the oracle clip counts.
    void emitBassClips(Track& longTrack, Track& shortTrack, const std::string& segName,
                       double startSec, double endSec, const std::vector<TimeNote>& notes) {
        static constexpr double SUSTAIN_TAIL_BEATS = 2.0;
        Clip longClip;  longClip.name  = segName; longClip.type  = "midi";
        longClip.startSec = startSec;  longClip.endSec = endSec;
        Clip shortClip; shortClip.name = segName; shortClip.type = "midi";
        shortClip.startSec = startSec; shortClip.endSec = endSec;

        for (const auto& tn : notes) {
            if (tn.duration > 0.5) {
                TimeNote sustained = tn;
                sustained.duration += SUSTAIN_TAIL_BEATS;
                addNoteToClip(longClip, sustained, vmBeat);
            } else {
                addNoteToClip(shortClip, tn, vmBeat);
            }
        }
        sortClipNotes(longClip);
        sortClipNotes(shortClip);
        longTrack.clips.push_back(std::move(longClip));
        shortTrack.clips.push_back(std::move(shortClip));
    }

    // The native harness dumps notes via te::MidiList::getSortedList(), which is
    // the insertion-ordered note array run through `std::sort` keyed on start
    // beat (tracktion_MidiList.h:175 — std::sort, NOT stable). Equal-start ties
    // therefore resolve by libstdc++'s introsort permutation, not insertion
    // order. We reproduce it exactly: keep notes in build (= addNote) order, then
    // the SAME std::sort + comparator under the SAME libstdc++ yields the SAME
    // tie ordering. (Note content doesn't enter the comparator, so sorting our
    // IR struct matches sorting their MidiNote* array note-for-note.)
    static void sortClipNotes(Clip& clip) {
        std::sort(clip.notes.begin(), clip.notes.end(),
                  [](const Note& a, const Note& b) { return a.startBeat < b.startBeat; });
    }
};

} // namespace casperaki
