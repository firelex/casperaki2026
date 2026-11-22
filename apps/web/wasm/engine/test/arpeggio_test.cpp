// Arpeggio note types in the tonal lane (Tonal.h): the EDM arpeggiator
// (legacy SequencerUtils.h:343-599 getEDMArpeggiatorNotes) and the plain keys
// arpeggio (SequencerUtils.h:160-178 getArpeggioNotes). No fixture golden
// exercises either type, so every expected note below is derived by hand from
// the legacy algorithm (see the per-case comments) and asserted exactly:
// pitch, start beat, length and — through addNoteToClip — beat-mode velocity.

#include "../src/Tonal.h"

#include <cstdio>
#include <string>
#include <vector>

namespace {
int failures = 0;
void check(bool cond, const std::string& msg) {
    if (!cond) { std::printf("FAIL: %s\n", msg.c_str()); ++failures; }
}

using casperaki::json;
using casperaki::TimeNote;

struct Expect { int midi; double start; double len; };

// Structure bars: one chord symbol per beat, four beats per bar.
json segmentBarsOf(const std::vector<std::string>& barChords) {
    json bars = json::array();
    for (const auto& c : barChords) bars.push_back({{"chords", {c, c, c, c}}});
    return bars;
}

// The brain's EDMArpeggiator shape (packages/arrangement/src/patterns/synths.ts
// emitEdmArpeggiator): a 2-bar pattern, one seed event at bar 0 beat 0, bar 1 empty.
json edmPatternBars(const std::string& type, const std::string& rhythm, int octaves, double noteDuration) {
    json ev = {{"type", "EDMArpeggiator"}, {"chord", "C"}, {"arpeggioType", type},
               {"arpeggioRhythm", rhythm}, {"numberOfOctaves", octaves},
               {"duration", 0.25}, {"noteDuration", noteDuration}};
    return json::array({ {{"notes", {{"0", json::array({ev})}}}}, {{"notes", json::object()}} });
}

void expectNotes(const std::string& label, const std::vector<TimeNote>& got, const std::vector<Expect>& want) {
    check(got.size() == want.size(),
          label + ": note count " + std::to_string(got.size()) + " != " + std::to_string(want.size()));
    for (size_t i = 0; i < got.size() && i < want.size(); ++i) {
        const std::string at = label + " note " + std::to_string(i);
        check(got[i].note.midiNote == want[i].midi,
              at + ": midi " + std::to_string(got[i].note.midiNote) + " != " + std::to_string(want[i].midi));
        check(got[i].start == want[i].start,
              at + ": start " + std::to_string(got[i].start) + " != " + std::to_string(want[i].start));
        check(got[i].duration == want[i].len,
              at + ": len " + std::to_string(got[i].duration) + " != " + std::to_string(want[i].len));
    }
}

template <typename F>
void expectThrows(const std::string& label, F f) {
    bool threw = false;
    try { f(); } catch (const std::exception&) { threw = true; }
    check(threw, label + ": expected a throw");
}
} // namespace

int main() {
    using namespace casperaki;
    Chord songKey{"C"};

    // (1) up / eighthNotes / 2 octaves, chords C then Am. Range B3(59)..C6(84),
    // increment 1, cycle reset at beat 0 and beat 4. Each step = next chord tone
    // above the previous; beat 4 restarts from B3 on the Am chord.
    {
        auto notes = buildTonalNotes(edmPatternBars("up", "eighthNotes", 2, 0.25),
                                     segmentBarsOf({"C", "Am"}), songKey, 0, false);
        expectNotes("up/eighth/2", notes, {
            {60, 0, 0.25}, {64, 0.5, 0.25}, {67, 1, 0.25}, {72, 1.5, 0.25},
            {76, 2, 0.25}, {79, 2.5, 0.25}, {84, 3, 0.25}, {88, 3.5, 0.25},
            {60, 4, 0.25}, {64, 4.5, 0.25}, {69, 5, 0.25}, {72, 5.5, 0.25},
            {76, 6, 0.25}, {81, 6.5, 0.25}, {84, 7, 0.25}, {88, 7.5, 0.25},
        });
        // Synths lane: +2 beat sustain tail, VelocityMode::beat (0.9/0.7/0.5/0.3 * 127).
        Clip clip;
        for (auto tn : notes) { tn.duration += 2.0; addNoteToClip(clip, tn, vmBeat); }
        const int wantVel[16] = {114, 38, 63, 38, 88, 38, 63, 38, 114, 38, 63, 38, 88, 38, 63, 38};
        for (size_t i = 0; i < clip.notes.size() && i < 16; ++i)
            check(clip.notes[i].vel == wantVel[i], "up/eighth/2 velocity " + std::to_string(i) + " = " +
                                                   std::to_string(clip.notes[i].vel));
        check(clip.notes.size() == 16, "up/eighth/2 clip note count");
        check(clip.notes[0].name == "C4" && clip.notes[0].lenBeats == 2.25, "up/eighth/2 first clip note");
    }

    // (2) downAndUp / eighthNotes332 / 3 octaves, octaveAdjustment -1, chords C
    // then G, noteDuration 1.0 (so each length = gap to the next step, last =
    // 8 - 7.5). Range B1(35)..C5(72), increment 2 (skip one chord tone). Starts
    // going down from C5; beat 4 flips to up from B1.
    {
        auto notes = buildTonalNotes(edmPatternBars("downAndUp", "eighthNotes332", 3, 1.0),
                                     segmentBarsOf({"C", "G"}), songKey, -1, false);
        expectNotes("downAndUp/eighth332/3/oct-1", notes, {
            {64, 0, 0.75}, {55, 0.75, 0.75}, {48, 1.5, 0.5}, {40, 2, 0.75},
            {31, 2.75, 0.75}, {24, 3.5, 0.5}, {43, 4, 0.75}, {50, 4.75, 0.75},
            {59, 5.5, 0.5}, {67, 6, 0.75}, {74, 6.75, 0.75}, {83, 7.5, 0.5},
        });
    }

    // (3) insideOut / sixteenthNotes / 2 octaves on a ONE-bar Am segment. Middle
    // F#5(78); alternates the next tone below / above the middle, widening, and
    // resets at beats 2/4/6. The run stops at beat 4: the chord lookup runs past
    // the segment (invalid chord) and the legacy loop breaks.
    {
        auto notes = buildTonalNotes(edmPatternBars("insideOut", "sixteenthNotes", 2, 0.5),
                                     segmentBarsOf({"Am"}), songKey, 0, false);
        expectNotes("insideOut/16th/2/1bar", notes, {
            {76, 0, 0.25}, {81, 0.25, 0.25}, {72, 0.5, 0.25}, {84, 0.75, 0.25},
            {69, 1, 0.25}, {88, 1.25, 0.25}, {64, 1.5, 0.25}, {93, 1.75, 0.25},
            {76, 2, 0.25}, {81, 2.25, 0.25}, {72, 2.5, 0.25}, {84, 2.75, 0.25},
            {69, 3, 0.25}, {88, 3.25, 0.25}, {64, 3.5, 0.25}, {93, 3.75, 0.25},
        });
    }

    // (4) The 2-bar pattern repeats by barIndex % 2: a 4-bar segment seeds a
    // second run at bar 2 (absolute starts 8..), and the empty bar 1/3 adds none.
    {
        auto notes = buildTonalNotes(edmPatternBars("up", "quarterNotes", 2, 0.25),
                                     segmentBarsOf({"C", "C", "C", "C"}), songKey, 0, false);
        expectNotes("up/quarter/2/4bars", notes, {
            {60, 0, 0.25}, {64, 1, 0.25}, {67, 2, 0.25}, {72, 3, 0.25},
            {60, 4, 0.25}, {64, 5, 0.25}, {67, 6, 0.25}, {72, 7, 0.25},
            {60, 8, 0.25}, {64, 9, 0.25}, {67, 10, 0.25}, {72, 11, 0.25},
            {60, 12, 0.25}, {64, 13, 0.25}, {67, 14, 0.25}, {72, 15, 0.25},
        });
    }

    // (5) Malformed EDMArpeggiator events throw (no silent defaults).
    {
        json segBars = segmentBarsOf({"C", "C"});
        auto bars = edmPatternBars("up", "eighthNotes", 2, 0.25);
        json noDur = bars; noDur[0]["notes"]["0"][0].erase("noteDuration");
        expectThrows("EDM missing noteDuration", [&] { buildTonalNotes(noDur, segBars, songKey, 0, false); });
        expectThrows("EDM bad rhythm", [&] {
            buildTonalNotes(edmPatternBars("up", "wholeNotes", 2, 0.25), segBars, songKey, 0, false); });
        expectThrows("EDM bad type", [&] {
            buildTonalNotes(edmPatternBars("sideways", "eighthNotes", 2, 0.25), segBars, songKey, 0, false); });
        expectThrows("EDM bad octaves", [&] {
            buildTonalNotes(edmPatternBars("up", "eighthNotes", 5, 0.25), segBars, songKey, 0, false); });
    }

    // (6) Plain keys arpeggio (packages/arrangement keys.ts shape; octave is an
    // integer). Base C{octave} + 12*octaveAdjustment, walk the chord `direction`
    // for note+1 tones, take the note-th. At beat 1, C chord, octave 4, up,
    // note 1: C4(60) -> [C4, E4] -> E4(64); with octaveAdjustment +1 -> E5(76).
    // duration 0.5 fits before the next beat, so chord-breaking leaves it whole.
    {
        json ev = {{"type", "arpeggio"}, {"chord", "C"}, {"octave", 4}, {"direction", "up"},
                   {"numberOfNotes", 3}, {"note", 1}, {"duration", 0.5}};
        json bars = json::array({ {{"notes", {{"1", json::array({ev})}}}} });
        json segBars = segmentBarsOf({"C"});
        expectNotes("arpeggio oct4 note1", buildTonalNotes(bars, segBars, songKey, 0, false), {{64, 1, 0.5}});
        expectNotes("arpeggio oct4 note1 adj+1", buildTonalNotes(bars, segBars, songKey, 1, false), {{76, 1, 0.5}});

        // down from C5(72), note 2: [C5, G4, E4] -> E4(64).
        json evDown = ev; evDown["octave"] = 5; evDown["direction"] = "down"; evDown["note"] = 2;
        json barsDown = json::array({ {{"notes", {{"1", json::array({evDown})}}}} });
        expectNotes("arpeggio oct5 down note2", buildTonalNotes(barsDown, segBars, songKey, 0, false), {{64, 1, 0.5}});

        json noOct = bars; noOct[0]["notes"]["1"][0].erase("octave");
        expectThrows("arpeggio missing octave", [&] { buildTonalNotes(noOct, segBars, songKey, 0, false); });
    }

    if (failures) { std::printf("arpeggio_test: %d failure(s)\n", failures); return 1; }
    std::printf("arpeggio_test: OK\n");
    return 0;
}
