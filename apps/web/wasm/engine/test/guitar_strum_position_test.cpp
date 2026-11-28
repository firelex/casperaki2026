// A Virtual Guitarist strum keeps where it is written (gridBeat) apart from where its sample starts (start, moved
// earlier by the sample's timing offset), so its velocity by position (legacyTonalVelocity) reads the written place.
#include "../src/Guitar.h"

#include <cmath>
#include <cstdio>

using json = nlohmann::json;
static int failures = 0;
static void expect(bool ok, const char* what) { if (!ok) { std::printf("FAIL %s\n", what); ++failures; } }

int main() {
    using namespace casperaki;
    const json noteBars = json::parse(R"([{"notes": {
        "0.0": [{"type": "virtualGuitarist", "chord": "C", "event": "chordShortStrumDown", "duration": 0.25}],
        "2.5": [{"type": "virtualGuitarist", "chord": "C", "event": "chordLongStrumUp", "duration": 1}]}}])");
    const json segmentBars = json::parse(R"([{"chords": ["C","C","C","C"]}, {"chords": ["G","G","G","G"]}])");
    music::Chord key{"C"};
    const auto out = buildGuitarSegment(noteBars, segmentBars, key, 0, false, 110.0, false);
    expect(out.timeStrums.size() == 4, "two strums a bar over two bars");
    const double want[4] = {0.0, 2.5, 4.0, 6.5};
    for (size_t i = 0; i < out.timeStrums.size() && i < 4; ++i) {
        expect(std::fabs(out.timeStrums[i].gridBeat - want[i]) < 1e-9, "gridBeat is the written beat");
        expect(out.timeStrums[i].start < out.timeStrums[i].gridBeat, "the sample starts a little before it");
    }
    if (failures == 0) std::printf("guitar_strum_position_test: all passed\n");
    return failures == 0 ? 0 : 1;
}
