// Phase 2 spike — native render harness.
//
// JUCEApplication::initialise() stages the engine and fixture but does NOT
// render. The render is deferred to a one-shot juce::Timer so the message
// thread returns to its normal dispatch loop before Tracktion's renderer
// (which internally uses callBlocking onto the message thread) runs.
//
// Engine is `new`'d once and intentionally leaked: its destructor reaches
// into Tracktion singletons that are already torn down by the time JUCE
// shuts us down.

#include <chrono>
#include <iostream>
#include <fstream>
#include <sstream>
#include <filesystem>
#include <vector>
#include <thread>
#include <atomic>
#include <cstdlib>
#include <cstdint>

#include <JuceHeader.h>
#include "CasperakiEngine.h"
#include "matchering_postprocess.h"
#include "edit_vst3_rewrite.h"  // docs/65 — rewrite custom built-ins -> VST3

namespace fs = std::filesystem;

// docs/60 Phase 0 — resolution oracle. Render-independent name for a MIDI note.
static juce::String midiNoteName(int n)
{
    return juce::MidiMessage::getMidiNoteName(n, true, true, 4);
}

static std::string readFile(const fs::path& p)
{
    std::ifstream f(p, std::ios::in | std::ios::binary);
    if (!f) throw std::runtime_error("cannot open " + p.string());
    std::stringstream ss;
    ss << f.rdbuf();
    return ss.str();
}

class SpikeApp : public juce::JUCEApplication, private juce::Timer
{
public:
    const juce::String getApplicationName() override    { return "CasperakiSpike"; }
    const juce::String getApplicationVersion() override { return "0.1.0"; }
    bool moreThanOneInstanceAllowed() override          { return true; }

    void initialise(const juce::String& /*cmdLine*/) override
    {
        std::setvbuf(stdout, nullptr, _IOLBF, 0);
        std::setvbuf(stderr, nullptr, _IOLBF, 0);

        const auto args = JUCEApplicationBase::getCommandLineParameterArray();
        if (args.size() < 1) {
            std::cerr << "usage: casperaki_spike <envelope-dir> [sample-base-url] [out.wav]\n";
            setApplicationReturnValue(1);
            quit();
            return;
        }
        envelopeDir = fs::absolute(fs::path(args[0].toStdString()));
        baseURL = args.size() >= 2 ? args[1] : juce::String("");
        outWavPath = fs::absolute(args.size() >= 3
            ? fs::path(args[2].toStdString())
            : envelopeDir / "out.wav");

        std::cout << "[harness] dir=" << envelopeDir
                  << " base=" << baseURL
                  << " out=" << outWavPath << std::endl;

        // CasperakiEngine starts a juce::HighResolutionTimer in its ctor
        // (CasperakiEngine.cpp:179) only if the controlStateCallback is
        // non-null. The timer fires hiResTimerCallback->getControlState()
        // from a non-message-thread, racing against our edit mutations.
        // Pass an EMPTY std::function so startTimer is never called.
        std::function<void(CasperakiEngine::ControlState)> noCallback;
        engine = new CasperakiEngine(noCallback);

        // Headless render — WSL2 has no audio hardware so
        // DeviceManager.getCurrentAudioDevice() returns nullptr and
        // SamplerPlugins get prepared at sample-rate 0, producing silence.
        // HostedAudioDeviceInterface installs a virtual 44.1k/512 device,
        // exactly the "no hardware needed" path Tracktion ships for
        // offline rendering.
        auto& trEngine = engine->getEdit()->engine;
        auto& hosted = trEngine.getDeviceManager().getHostedAudioDeviceInterface();
        te::HostedAudioDeviceInterface::Parameters hostedParams;
        hostedParams.sampleRate = 44100.0;
        hostedParams.blockSize = 512;
        hostedParams.inputChannels = 0;
        hostedParams.outputChannels = 2;
        hostedParams.useMidiDevices = false;
        hosted.initialise(hostedParams);
        hosted.prepareToPlay(44100.0, 512);
        std::cout << "[harness] HostedAudioDeviceInterface initialised "
                  << "sr=" << trEngine.getDeviceManager().getSampleRate()
                  << " blk=" << trEngine.getDeviceManager().getBlockSize()
                  << std::endl;

        // The original Edit was created by CasperakiEngine's ctor BEFORE we
        // installed the hosted audio device — any device bindings cached on
        // tracks at that time still point at the (empty) ALSA device. Recreate
        // the Edit so all tracks bind to the hosted device.
        engine->prepareEdit();
        std::cout << "[harness] re-prepared edit after hosted device install"
                  << std::endl;

        // The Sequencer's genre drives the per-genre FX plugin chains in
        // prepareInstrumentTracksWithPlugins (Sequencer.cpp:240). Production
        // reads it from the song (CasperakiEngine.cpp:560); hardcoding "edm"
        // here rendered every genre with edm's FX racks. Read it from
        // song.json so each genre gets its own chain, as per the legacy app.
        const auto songJson = readFile(envelopeDir / "song.json");
        juce::String genre =
            juce::JSON::parse(juce::String(songJson))["genre"].toString();
        if (genre.isEmpty()) {
            std::cerr << "[harness] WARNING: song.json has no genre; "
                      << "defaulting to edm" << std::endl;
            genre = "edm";
        }
        std::cout << "[harness] genre=" << genre << std::endl;
        genreName = genre;
        engine->initialiseSequencer(genre);

        std::vector<fs::path> instFiles;
        for (auto& e : fs::directory_iterator(envelopeDir)) {
            const auto name = e.path().filename().string();
            if (name.rfind("inst-", 0) == 0 && e.path().extension() == ".json")
                instFiles.push_back(e.path());
        }
        std::sort(instFiles.begin(), instFiles.end(),
                  [](const fs::path& a, const fs::path& b) {
                      auto n = [](const fs::path& p) {
                          return std::stoi(p.stem().string().substr(5));
                      };
                      return n(a) < n(b);
                  });
        std::cout << "[harness] " << instFiles.size() << " instruments to add" << std::endl;

        for (const auto& instPath : instFiles) {
            std::cout << "[harness] addInstrument " << instPath.filename().string() << std::endl;
            engine->addInstrument(readFile(instPath), baseURL);
        }

        std::cout << "[harness] setSong(" << songJson.size() << " bytes)" << std::endl;
        engine->setSong(songJson);

        // Defer the render — let initialise() return and the message thread
        // resume its dispatch loop. The renderer relies on callBlocking onto
        // the message thread (Renderer.cpp:46), which deadlocks when called
        // synchronously from within initialise(). Long delay so we can
        // distinguish "crashes during message-loop idle" from "crashes
        // inside the render".
        std::cout << "[harness] scheduling deferred render in 3000ms" << std::endl;
        startTimer(3000);
    }

    void timerCallback() override
    {
        stopTimer();
        try {
            runRender();
        } catch (const std::exception& e) {
            std::cerr << "[harness] FATAL: " << e.what() << '\n';
            setApplicationReturnValue(3);
        }
        // Headless one-shot: the render is finished and the WAV is fully written
        // and closed by the Renderer. Do NOT fall back to the JUCE dispatch loop
        // to quit. On Linux, JUCEApplication::quit() posts a QuitMessage, but
        // MessageManager::MessageBase::post() silently DROPS every message once
        // MessageManager::quitMessagePosted is latched true — and the render's
        // nested dispatch loop (renderToFile useThread=true) latches it, and JUCE
        // never clears it. So quit() returns yet quitMessageReceived never flips
        // and runDispatchLoop() spins forever -> the process idles indefinitely.
        // This (NOT Wine/yabridge or the leak detector) is the long-blamed
        // "teardown hang". Exit straight away, mirroring the render watchdog's
        // std::_Exit(124) above. stdio is line-buffered; the WAV is already closed.
        const int rc = getApplicationReturnValue();
        std::cout << "[harness] render complete (rc=" << rc << "); exiting cleanly" << std::endl;
        std::cout.flush();
        std::cerr.flush();
        std::_Exit(rc);
    }

    void shutdown() override {}

private:
    void runRender()
    {
        auto* ed = engine->getEdit();
        if (ed == nullptr) {
            std::cerr << "[harness] getEdit() returned nullptr\n";
            setApplicationReturnValue(2);
            return;
        }

        fs::create_directories(outWavPath.parent_path());
        const juce::File destFile(outWavPath.string());

        // docs/60 Phase 0 — resolved-event dump (resolution oracle). Set
        // SPIKE_DUMP_EVENTS=<path.json> to serialize the fully-resolved te::
        // schedule (MIDI notes, drum step patterns, sample clips) just before
        // the render — i.e. *after* the 3 s settle so async drum-pattern fills
        // are in. The future WASM engine emits the same shape; diffing the two
        // validates musical resolution independently of any audio comparison.
        if (const char* dumpPath = std::getenv("SPIKE_DUMP_EVENTS")) {
            try {
                dumpResolvedEvents(fs::absolute(fs::path(dumpPath)));
            } catch (const std::exception& e) {
                std::cerr << "[harness] resolved-event dump failed: " << e.what() << '\n';
            }
        }

        // Keep the remapped rack chains (Tracktion-internal AirWindows +
        // Consolidated + SimpleSide + yabridged Valhalla) so the
        // master/submix/send DSP matches the legacy mix path. There is no
        // production dry-render escape hatch here; dry A/B diagnostics should
        // use a dedicated tool so the app cannot accidentally bypass the mix.
        std::cout << "[harness] rack plugin chains enabled" << std::endl;

        // Optional debug tone clip: set SPIKE_INJECT_TONE=1 to insert a
        // known-good 2s 440Hz clip on a new audio track. Off by default so
        // we can isolate Drums/SamplerPlugin audio for the success gate.
        if (std::getenv("SPIKE_INJECT_TONE") != nullptr) {
            const fs::path toneWav = fs::absolute(
                fs::path(envelopeDir.parent_path().parent_path()) /
                "samples/tone-2s.wav");
            const juce::File toneFile(toneWav.string());
            std::cout << "[harness] toneFile=" << toneFile.getFullPathName()
                      << " exists=" << (toneFile.existsAsFile() ? "yes" : "no")
                      << " size=" << toneFile.getSize() << std::endl;

            ed->ensureNumberOfAudioTracks(te::getAudioTracks(*ed).size() + 1);
            auto allTracks = te::getAudioTracks(*ed);
            auto* toneTrack = allTracks[allTracks.size() - 1];
            toneTrack->setName("spike-tone");
            const te::ClipPosition clipPos {
                { te::TimePosition::fromSeconds(0.0), te::TimePosition::fromSeconds(2.0) },
                te::TimeDuration::fromSeconds(0.0)
            };
            if (toneTrack->insertWaveClip("spike-tone-clip", toneFile, clipPos, false))
                std::cout << "[harness] inserted tone clip" << std::endl;
            else
                std::cout << "[harness] FAILED to insert tone clip" << std::endl;
        }

        // renderToFile(Edit&, File&, useThread=true) — selects ALL tracks
        // (incl. master) with default Parameters and runs via the engine's
        // HeadlessUIBehaviour::runTaskWithProgressBar (CasperakiEngine.cpp).
        //
        // docs/57f — duplicate-lane render hang root cause. The earlier
        // useThread=false path runs the render as a tight
        //   while (task->runJob() == jobNeedsRunningAgain) {}
        // loop directly on the message thread (Renderer.cpp:472). That
        // starves the message thread: Tracktion requests a clip proxy
        // (e.g. a Loop/transition WaveClip) lazily while building the
        // render graph and kicks proxy generation off via the
        // AudioFileManager's juce::AsyncUpdater. With the message thread
        // wedged in the runJob loop, that async kick-off never dispatches,
        // the proxy .wav is never written, so the clip's WaveNode reports
        // isReadyToProcess()==false forever (reader sample-rate 0) and the
        // render spins/deadlocks — the WAV freezes mid-write. It surfaced
        // with >=2 populated leadSynths lanes only because the extra setup
        // work pushed one proxy kick-off past the point the render started.
        //
        // useThread=true routes through HeadlessUIBehaviour, which runs the
        // render task on a background thread and pumps the message loop
        // (runDispatchLoopUntil) on this thread — so the proxy async kick-off
        // dispatches, proxies generate on the cache's background pool, the
        // WaveNodes become ready and the render completes. JUCE_MODAL_LOOPS_-
        // PERMITTED (set in CMakeLists) is what makes that nested pump legal.
        std::cout << "[harness] renderToFile(Edit&, File&, useThread=true): "
                  << "dest=" << destFile.getFullPathName()
                  << " len=" << ed->getLength().inSeconds() << "s"
                  << std::endl;

        // Render watchdog (docs/57f — duplicate-lane hang backstop). The
        // useThread=true fix below addresses the known stall, but a render
        // that wedges for any reason (a future graph/proxy regression, a
        // hung plugin) would otherwise peg CPU and freeze the output WAV
        // mid-write, stalling the whole render-all-genres matrix on a single
        // bad genre. A dedicated OS thread (independent of the message
        // thread) watches the output file: if it stops
        // growing for SPIKE_RENDER_STALL_SECS, or the whole render exceeds
        // SPIKE_RENDER_TIMEOUT_SECS, we abort fast with rc=124 (timeout-style)
        // and a diagnostic, instead of hanging. Tunable via env; 0 disables.
        const auto envSecs = [](const char* name, long fallback) -> long {
            if (const char* v = std::getenv(name)) {
                char* end = nullptr;
                const long n = std::strtol(v, &end, 10);
                if (end != v && n >= 0) return n;
            }
            return fallback;
        };
        const long stallSecs   = envSecs("SPIKE_RENDER_STALL_SECS", 60);
        const long timeoutSecs = envSecs("SPIKE_RENDER_TIMEOUT_SECS", 600);

        std::atomic<bool> renderDone{false};
        std::thread watchdog;
        if (stallSecs > 0 || timeoutSecs > 0) {
            const std::string watchPath = outWavPath.string();
            watchdog = std::thread([&renderDone, watchPath, stallSecs, timeoutSecs] {
                using clock = std::chrono::steady_clock;
                const auto start = clock::now();
                auto lastGrowth = start;
                std::uintmax_t lastSize = 0;
                for (;;) {
                    for (int i = 0; i < 20 && ! renderDone.load(); ++i)
                        std::this_thread::sleep_for(std::chrono::milliseconds(100));
                    if (renderDone.load()) return;

                    const auto now = clock::now();
                    std::error_code ec;
                    const auto size = fs::exists(watchPath, ec)
                        ? fs::file_size(watchPath, ec) : std::uintmax_t{0};
                    if (! ec && size > lastSize) { lastSize = size; lastGrowth = now; }

                    const auto elapsed = std::chrono::duration_cast<std::chrono::seconds>(now - start).count();
                    const auto sinceGrowth = std::chrono::duration_cast<std::chrono::seconds>(now - lastGrowth).count();

                    const bool hardTimeout = timeoutSecs > 0 && elapsed >= timeoutSecs;
                    // Only treat a no-growth period as a stall once some audio
                    // has been written (lastSize>0): plugin scan / graph build
                    // legitimately precedes the first WAV bytes.
                    const bool stalled = stallSecs > 0 && lastSize > 0 && sinceGrowth >= stallSecs;
                    if (hardTimeout || stalled) {
                        std::cerr << "[harness] RENDER WATCHDOG: aborting — "
                                  << (hardTimeout ? "exceeded SPIKE_RENDER_TIMEOUT_SECS"
                                                  : "output stalled (no growth) past SPIKE_RENDER_STALL_SECS")
                                  << " (elapsed=" << elapsed << "s, lastSize=" << lastSize
                                  << "B, sinceGrowth=" << sinceGrowth << "s)" << std::endl;
                        std::cerr.flush();
                        std::cout.flush();
                        std::_Exit(124);
                    }
                }
            });
        }

        // DEBUG: CASPERAKI_SOLO=<track-name-substr> renders ONLY the matching
        // track(s) plus the routing tracks (MASTER + the 3 aux returns), via the
        // tracksToDo renderToFile overload below. setMute/volume are unreliable
        // here (the simple renderToFile ignores mute; instrument tracks have no
        // volume plugin to kill), so we explicitly SELECT which tracks render.
        // tracksToDo bits index getAllTracks(edit). Empty => normal full render.
        juce::BigInteger soloTracks;
        if (const char* solo = std::getenv("CASPERAKI_SOLO"); solo != nullptr && *solo != '\0') {
            auto isRouting = [](const juce::String& n) {
                return n.equalsIgnoreCase("MASTER")
                    || n.startsWithIgnoreCase("fxPlateReverb")
                    || n.startsWithIgnoreCase("fxStereoDelay")
                    || n.startsWithIgnoreCase("fxChorus");
            };
            auto all = te::getAllTracks(*ed);
            int kept = 0;
            for (int i = 0; i < all.size(); ++i) {
                auto* t = all.getUnchecked(i);
                if (t == nullptr) continue;
                if (t->getName().containsIgnoreCase(solo) || isRouting(t->getName())) {
                    soloTracks.setBit(i);
                    ++kept;
                }
            }
            std::cout << "[harness] CASPERAKI_SOLO='" << solo << "' selecting " << kept
                      << " of " << all.size() << " track(s)" << std::endl;
        }

        // DO NOT switch this back to useThread=false. On this message-thread
        // render path, false runs renderToFile as a tight runJob() loop that
        // starves the message thread, so lazy proxy generation (kicked off via
        // the AudioFileManager's AsyncUpdater) never dispatches and the render
        // deadlocks on a WaveNode that is never ready (docs/57f). true routes
        // through HeadlessUIBehaviour, which pumps the message loop.
        const bool ok = soloTracks.isZero()
            ? te::Renderer::renderToFile(*ed, destFile, /*useThread*/ true)
            : te::Renderer::renderToFile("solo", destFile, *ed,
                  te::TimeRange(te::TimePosition(), ed->getLength()),
                  soloTracks, /*usePlugins*/ true, /*useACID*/ true, {}, /*useThread*/ true);

        renderDone.store(true);
        if (watchdog.joinable())
            watchdog.join();

        std::cout << "[harness] renderToFile returned " << (ok ? "true" : "false")
                  << " exists=" << (destFile.existsAsFile() ? "yes" : "no")
                  << " size=" << destFile.getSize() << std::endl;

        const bool renderOK = destFile.existsAsFile() && destFile.getSize() > 0;

        // SPIKE_MASTER=1 enables the legacy matchering post-process.
        // Mirrors InstrumentalGenerator::saveAndExportSong's shouldMaster
        // path: master the rendered WAV against the embedded
        // referenceAtemlos.wav and write to <stem>_mastered.wav next to
        // the dry render. Default OFF so the 56d matrix and other gates
        // see the same dry output they always did.
        if (renderOK && std::getenv("SPIKE_MASTER") != nullptr) {
            const fs::path masteredPath = outWavPath.parent_path() /
                (outWavPath.stem().string() + "_mastered.wav");
            const juce::File masteredFile(masteredPath.string());
            std::cout << "[harness] SPIKE_MASTER=1 — invoking matchering post-process "
                      << "src=" << destFile.getFullPathName()
                      << " dst=" << masteredFile.getFullPathName() << std::endl;
            const auto t0 = std::chrono::steady_clock::now();
            casperaki::matchering::masterAgainstAtemlos(destFile, masteredFile, /*shouldLimit*/ true);
            const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now() - t0).count();
            std::cout << "[harness] matchering done in " << ms << "ms"
                      << " exists=" << (masteredFile.existsAsFile() ? "yes" : "no")
                      << " size=" << masteredFile.getSize() << std::endl;
        }

        // docs/65 — VST3 export: rewrite the rendered edit so the Casperaki
        // built-in FX become installable VST3 references, then reload + render
        // it to verify every plugin resolves and the audio matches out.wav.
        if (renderOK) {
            if (const char* vd = std::getenv("CASPERAKI_VST3_DIR"); vd != nullptr && *vd != '\0') {
                try {
                    auto* liveEd = engine->getEdit();
                    // Write next to the temp edit.trkedit so its relative sample
                    // refs (../playsample-N.ogg) still resolve when bundled.
                    const juce::File vst3Edit(
                        liveEd->editFileRetriever().getParentDirectory().getChildFile("edit-vst3.trkedit"));
                    std::string report;
                    std::cout << "[vst3] rewriting edit -> " << vst3Edit.getFullPathName() << std::endl;
                    const int swapped = casperaki_export::rewriteEditToVst3(
                        *liveEd, juce::File(vd), vst3Edit, report);
                    std::cout << report;
                    std::cout << "[vst3] swapped " << swapped << " plugin(s)" << std::endl;

                    // NOTE: every swapped VST3 was loaded SYNCHRONOUSLY during the
                    // rewrite (createPluginInstance, logged above) — that is the
                    // in-harness proof the references resolve + their state was
                    // captured. We do NOT reload+render here to verify: a
                    // loadEditFromFile edit isn't bound to the harness's hosted
                    // audio device and its plugins stay idle/uninstantiated, so an
                    // in-process render hangs (headless device-binding, a separate
                    // problem). Render-parity is verified by opening edit-vst3.trkedit
                    // in Waveform (real device; VST3s resolve by uid once installed).
                } catch (const std::exception& e) {
                    std::cerr << "[vst3] rewrite/verify failed: " << e.what() << std::endl;
                }
            }
        }

        setApplicationReturnValue(renderOK ? 0 : 2);
    }

    // docs/60 Phase 0 — walk the resolved te::Edit and serialize its schedule.
    // This reads the already-resolved clips Tracktion holds (song.json -> te::
    // clips happens in the engine's Sequencer/instruments); the dump is the
    // Phase-0 "resolution IR" oracle, emitted from the harness so no external
    // engine source is touched.
    void dumpResolvedEvents(const fs::path& outPath)
    {
        auto* ed = engine->getEdit();
        if (ed == nullptr) throw std::runtime_error("getEdit() null");

        juce::DynamicObject::Ptr root = new juce::DynamicObject();
        root->setProperty("schema", "casperaki/resolved-events/v1");
        root->setProperty("genre", genreName);
        root->setProperty("lengthSec", ed->getLength().inSeconds());

        int totalNotes = 0, totalStepHits = 0, totalWaveClips = 0;
        juce::Array<juce::var> tracksArr;

        for (auto* track : te::getAudioTracks(*ed)) {
            juce::DynamicObject::Ptr tObj = new juce::DynamicObject();
            tObj->setProperty("name", track->getName());

            juce::Array<juce::var> clipsArr;
            for (auto* clip : track->getClips()) {
                juce::DynamicObject::Ptr cObj = new juce::DynamicObject();
                cObj->setProperty("name", clip->getName());
                const auto pos = clip->getPosition();
                cObj->setProperty("startSec", pos.time.getStart().inSeconds());
                cObj->setProperty("endSec",   pos.time.getEnd().inSeconds());

                if (auto* midi = dynamic_cast<te::MidiClip*>(clip)) {
                    cObj->setProperty("type", "midi");
                    auto& seq = midi->getSequence();
                    juce::Array<juce::var> notesArr;
                    for (int i = 0; i < seq.getNumNotes(); ++i) {
                        auto* note = seq.getNote(i);
                        juce::DynamicObject::Ptr nObj = new juce::DynamicObject();
                        nObj->setProperty("n",         note->getNoteNumber());
                        nObj->setProperty("name",      midiNoteName(note->getNoteNumber()));
                        nObj->setProperty("startBeat", note->getStartBeat().inBeats());
                        nObj->setProperty("lenBeats",  note->getLengthBeats().inBeats());
                        nObj->setProperty("vel",       note->getVelocity());
                        notesArr.add(juce::var(nObj.get()));
                    }
                    totalNotes += notesArr.size();
                    cObj->setProperty("noteCount", notesArr.size());
                    cObj->setProperty("notes", notesArr);
                }
                else if (auto* step = dynamic_cast<te::StepClip*>(clip)) {
                    cObj->setProperty("type", "step");
                    const auto& channels = step->getChannels();
                    juce::Array<juce::var> chArr;
                    for (auto* ch : channels) {
                        juce::DynamicObject::Ptr chObj = new juce::DynamicObject();
                        chObj->setProperty("note", (int) ch->noteNumber);
                        chObj->setProperty("name", ch->name.get());
                        chArr.add(juce::var(chObj.get()));
                    }
                    cObj->setProperty("channels", chArr);

                    juce::Array<juce::var> patArr;
                    for (auto& pat : step->getPatterns()) {
                        juce::DynamicObject::Ptr pObj = new juce::DynamicObject();
                        pObj->setProperty("name", pat.getName());
                        const int numSteps = pat.getNumNotes();
                        pObj->setProperty("numSteps", numSteps);
                        juce::Array<juce::var> hitsArr;
                        for (int c = 0; c < channels.size(); ++c)
                            for (int s = 0; s < numSteps; ++s)
                                if (pat.getNote(c, s)) {
                                    juce::DynamicObject::Ptr h = new juce::DynamicObject();
                                    h->setProperty("ch",   c);
                                    h->setProperty("step", s);
                                    h->setProperty("vel",  pat.getVelocity(c, s));
                                    hitsArr.add(juce::var(h.get()));
                                }
                        totalStepHits += hitsArr.size();
                        pObj->setProperty("hits", hitsArr);
                        patArr.add(juce::var(pObj.get()));
                    }
                    cObj->setProperty("patterns", patArr);
                }
                else if (auto* wave = dynamic_cast<te::WaveAudioClip*>(clip)) {
                    cObj->setProperty("type", "wave");
                    cObj->setProperty("source",
                        wave->getSourceFileReference().getFile().getFileName());
                    ++totalWaveClips;
                }
                else {
                    cObj->setProperty("type",
                        te::TrackItem::typeToString(clip->type));
                }
                clipsArr.add(juce::var(cObj.get()));
            }

            // Skip silent/empty tracks to keep the dump readable.
            if (! clipsArr.isEmpty()) {
                tObj->setProperty("clips", clipsArr);
                tracksArr.add(juce::var(tObj.get()));
            }
        }

        juce::DynamicObject::Ptr totals = new juce::DynamicObject();
        totals->setProperty("tracks", tracksArr.size());
        totals->setProperty("notes", totalNotes);
        totals->setProperty("stepHits", totalStepHits);
        totals->setProperty("waveClips", totalWaveClips);
        root->setProperty("totals", juce::var(totals.get()));
        root->setProperty("tracks", tracksArr);

        const juce::String json =
            juce::JSON::toString(juce::var(root.get()), false /*multi-line*/);
        std::ofstream of(outPath, std::ios::binary);
        if (! of) throw std::runtime_error("cannot write " + outPath.string());
        of << json.toStdString();
        of.close();
        std::cout << "[harness] resolved-event dump → " << outPath
                  << " (tracks=" << tracksArr.size()
                  << " notes=" << totalNotes
                  << " stepHits=" << totalStepHits
                  << " waveClips=" << totalWaveClips << ")" << std::endl;
    }

    juce::String genreName;
    CasperakiEngine* engine = nullptr;
    fs::path envelopeDir;
    fs::path outWavPath;
    juce::String baseURL;
};

START_JUCE_APPLICATION(SpikeApp)
