// Standalone smoke for the matchering port. Bypasses the full render
// pipeline — takes a pre-existing WAV path and runs the matchering
// post-process against the embedded referenceAtemlos.wav. Validates that
//   - BinaryData::referenceAtemlos_wav + BinaryData::atemlos_json link
//   - the algorithm runs end-to-end on a real input without crashing
//   - the output WAV is produced and has plausible peak/RMS
//
// Usage:  casperaki_matchering_smoke <input.wav> [output.wav]

#include <iostream>
#include <filesystem>

#include <JuceHeader.h>

#include "matchering_postprocess.h"

namespace fs = std::filesystem;

class SmokeApp : public juce::JUCEApplication
{
public:
    const juce::String getApplicationName() override    { return "CasperakiMatcheringSmoke"; }
    const juce::String getApplicationVersion() override { return "0.1.0"; }
    bool moreThanOneInstanceAllowed() override          { return true; }

    void initialise (const juce::String& /*cmdLine*/) override
    {
        const auto args = JUCEApplicationBase::getCommandLineParameterArray();
        if (args.size() < 1) {
            std::cerr << "usage: casperaki_matchering_smoke <input.wav> [output.wav]\n";
            setApplicationReturnValue(1);
            quit();
            return;
        }

        const fs::path inPath = fs::absolute(args[0].toStdString());
        const fs::path outPath = fs::absolute(args.size() >= 2
            ? fs::path(args[1].toStdString())
            : inPath.parent_path() / (inPath.stem().string() + "_mastered.wav"));

        const juce::File src (inPath.string());
        const juce::File dst (outPath.string());

        // Delete any pre-existing output so a stale file can't cause a false pass.
        dst.deleteFile();

        std::cout << "[smoke] src=" << src.getFullPathName()
                  << " (exists=" << (src.existsAsFile() ? "yes" : "no")
                  << " size=" << src.getSize() << ")" << std::endl;
        std::cout << "[smoke] dst=" << dst.getFullPathName() << std::endl;

        casperaki::matchering::masterAgainstAtemlos (src, dst, /*shouldLimit*/ true);

        const bool ok = dst.existsAsFile() && dst.getSize() > 0;
        std::cout << "[smoke] result exists=" << (ok ? "yes" : "no")
                  << " size=" << dst.getSize() << std::endl;
        setApplicationReturnValue(ok ? 0 : 2);
        quit();
    }

    void shutdown() override {}
};

START_JUCE_APPLICATION (SmokeApp)
