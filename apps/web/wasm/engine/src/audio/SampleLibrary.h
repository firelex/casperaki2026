// Native real-sample loader (docs/60 Phase 1 finish). Reads a genre envelope's
// `asset-manifest.json` (+ the parsed inst-N.json) and the on-disk sample
// library, normalizes non-OGG/WAV sources through the same ffmpeg OGG cache the
// prestage/browser path uses, decodes/slices the real assets, and registers them
// into a Mixer by the SAME string keys the join looks up (Mixer.h header):
//
//   tonal/bass slot   -> decimal slot id        (sliced [sliceStart,sliceEnd]s)
//   drum step channel -> sub-instrument name     (whole one-shot)
//   wave/loop clip     -> "playsample-<id>.ogg"   (whole loop / transition)
//
// This is the native analogue of the browser's manifest-driven decode (the vite
// /render-demo plan + decodeAudioData). It is NEVER part of the wasm build — it
// links the codecs (AudioDecode.h). The slicing mirrors the prestage pipeline
// (apps/engine-spike/scripts/lib/stage-multisample.mjs): the canonical preset
// mp3 is cut at the manifest's per-slot [sliceStart,sliceEnd] (seconds), here
// done in-memory off the decoded PCM rather than via an ffmpeg re-encode.
//
// Normalized assets are stereo 44.1 kHz OGGs, matching the JUCE prestage path.
// A missing/unresolved asset is simply not registered, so the Mixer join falls
// back to the role stub.
#pragma once

#include "AudioDecode.h"
#include "Mixer.h"
#include "Sampler.h"
#include "../../vendor/json.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

namespace casperaki {

struct SampleLibraryStats {
    bool loaded = false;          // asset-manifest.json found + parsed
    int tonalSlots = 0, tonalMissing = 0;
    int drumLanes = 0, drumMissing = 0;
    int waveSources = 0, waveMissing = 0;
    int fretSlots = 0, fretMissing = 0;
    int strumSamples = 0, strumMissing = 0;
    int filesDecoded = 0, decodeFailures = 0;
};

class SampleLibrary {
public:
    // libraryRoot: absolute path the manifest's relativePath / inst sourcePath
    // resolve against (CASPERAKI_SAMPLE_LIBRARY_ROOT). Empty => nothing loads.
    SampleLibrary(std::string libraryRoot, int padFrames = 8192)
        : root_(std::move(libraryRoot)), pad_(padFrames) {}

    // Read the manifest in `genreDir`, decode/slice the real assets, and register
    // them into `mixer`. Call BEFORE mixer.build(). instJsons is the same parsed
    // inst list the resolver/mixer use (for wave/loop sourcePath resolution).
    SampleLibraryStats loadInto(Mixer& mixer, const std::filesystem::path& genreDir,
                                const std::vector<nlohmann::json>& instJsons) {
        SampleLibraryStats st;
        if (root_.empty()) return st;

        const auto manifestPath = genreDir / "asset-manifest.json";
        std::ifstream mf(manifestPath, std::ios::binary);
        if (!mf) return st;
        std::stringstream ss;
        ss << mf.rdbuf();
        nlohmann::json manifest;
        try { manifest = nlohmann::json::parse(ss.str()); }
        catch (...) { return st; }
        st.loaded = true;
        cacheRoot_ = resolveAudioCacheRoot(genreDir);

        loadTonal(mixer, manifest, instJsons, st);
        loadDrums(mixer, manifest, st);
        loadWaves(mixer, instJsons, st);
        loadFretNoises(mixer, manifest, instJsons, st);
        loadStrums(mixer, manifest, instJsons, st);
        return st;
    }

private:
    // ---- tonal/bass: per-slot slices of the canonical preset mp3 ----------
    void loadTonal(Mixer& mixer, const nlohmann::json& manifest,
                   const std::vector<nlohmann::json>& instJsons, SampleLibraryStats& st) {
        for (const auto& inst : instJsons) {
            if (!inst.contains("samples") || !inst["samples"].is_array() || inst["samples"].empty())
                continue;
            const std::string type = inst.value("type", std::string());
            if (type == "drums" || type == "transitionPattern") continue;  // mirror prestage
            const std::string name = inst.value("name", std::string());
            if (name.empty()) continue;

            const nlohmann::json* entry = laneEntry(manifest, name);
            if (!entry || entry->value("status", std::string()) != "resolved") continue;
            const std::string rel = entry->value("relativePath", std::string());
            if (rel.empty()) continue;
            if (!entry->contains("multisample")) continue;
            const auto& ms = (*entry)["multisample"];
            if (!ms.contains("slots") || !ms["slots"].is_array()) continue;

            auto decoded = decodeCached(rel, st);
            for (const auto& slot : ms["slots"]) {
                if (slot.value("status", std::string()) != "resolved") continue;
                if (!slot.contains("slot")) continue;
                const int id = slot["slot"].value("id", -1);
                if (id < 0) continue;
                const double s0 = slot.value("sliceStart", -1.0);
                const double s1 = slot.value("sliceEnd", -1.0);
                if (!(s1 > s0) || s0 < 0) { st.tonalMissing++; continue; }
                if (!decoded || !decoded->ok) { st.tonalMissing++; continue; }
                mixer.setSample(std::to_string(id), makeSlice(*decoded, s0, s1));
                st.tonalSlots++;
            }
        }
    }

    // ---- drums: whole one-shot per lane, keyed by sub-instrument name ------
    void loadDrums(Mixer& mixer, const nlohmann::json& manifest, SampleLibraryStats& st) {
        if (!manifest.contains("Drums")) return;
        const auto& drums = manifest["Drums"];
        if (!drums.contains("lanes") || !drums["lanes"].is_object()) return;
        for (const auto& [name, entry] : drums["lanes"].items()) {
            if (!entry.is_object() || entry.value("status", std::string()) != "resolved") continue;
            const std::string rel = entry.value("relativePath", std::string());
            if (rel.empty()) continue;
            auto decoded = decodeCached(rel, st);
            if (!decoded || !decoded->ok) { st.drumMissing++; continue; }
            mixer.setSample(name, makeSamplerWhole(*decoded));
            st.drumLanes++;
        }
    }

    // ---- wave/loop/transition: whole sample, keyed by playsample-<id>.ogg --
    void loadWaves(Mixer& mixer, const std::vector<nlohmann::json>& instJsons,
                   SampleLibraryStats& st) {
        std::unordered_map<int, std::string> idToSource;  // first-wins (resolver dedup)
        for (const auto& inst : instJsons) {
            const std::string type = inst.value("type", std::string());
            if (type == "transitionPattern") {
                if (inst.contains("samples") && inst["samples"].is_array())
                    for (const auto& s : inst["samples"]) {
                        const int id = s.value("id", -1);
                        const std::string src = s.value("sourcePath", std::string());
                        if (id >= 0 && !src.empty()) idToSource.emplace(id, src);
                    }
                continue;
            }
            const bool isWave = (type == "transitionSample" || type == "percussionLoops"
                                 || type == "percussion");
            if (!isWave) continue;
            const int id = inst.value("id", -1);
            const std::string src = inst.value("sourcePath", std::string());
            if (id >= 0 && !src.empty()) idToSource.emplace(id, src);
        }
        for (const auto& [id, rel] : idToSource) {
            auto decoded = decodeCached(rel, st);
            const std::string key = "playsample-" + std::to_string(id) + ".ogg";
            if (!decoded || !decoded->ok) { st.waveMissing++; continue; }
            mixer.setSample(key, makeWaveWhole(*decoded));
            st.waveSources++;
        }
        // audioClips (sung vocal takes): each clip's own file (an absolute sourcePath), keyed by the clip's key.
        for (const auto& inst : instJsons) {
            if (inst.value("type", std::string()) != "audioClips" || !inst.contains("clips")) continue;
            for (const auto& c : inst["clips"]) {
                const std::string key = c.value("key", std::string());
                const std::string src = c.value("sourcePath", std::string());
                // A take has no stand-in: a missing or unreadable one stops the render (never a silent vocal).
                if (key.empty() || src.empty())
                    throw std::runtime_error("SampleLibrary: audioClips '" + inst.value("name", std::string()) + "' has a clip without key or sourcePath");
                auto decoded = decodeCached(src, st);
                if (!decoded || !decoded->ok)
                    throw std::runtime_error("SampleLibrary: cannot read the audio clip " + src);
                mixer.setSample(key, makeWaveWhole(*decoded));
                st.waveSources++;
            }
        }
    }

    // ---- guitar fret-noises: N equal slices of the Default FX sibling ------
    // Mirrors prestage-samples.mjs (docs/54t): inst.fx.fxFretNoise[] lists the
    // playsample ids the engine maps to fret-noise midi notes 0..N-1; the catalog
    // sibling mp3 (manifest.Guitar.fretNoiseSibling.relativePath) is cut into N
    // equal slices, one hit per slice. Each slice binds by its id (decimal key) —
    // the same key Mixer::fretNoteToId resolves a fret note to.
    void loadFretNoises(Mixer& mixer, const nlohmann::json& manifest,
                        const std::vector<nlohmann::json>& instJsons, SampleLibraryStats& st) {
        if (!manifest.contains("Guitar")) return;
        const auto& g = manifest["Guitar"];
        if (!g.contains("fretNoiseSibling")) return;
        const std::string rel = g["fretNoiseSibling"].value("relativePath", std::string());
        if (rel.empty()) return;

        for (const auto& inst : instJsons) {
            if (!isGuitar(inst)) continue;
            if (!inst.contains("fx") || !inst["fx"].contains("fxFretNoise")
                || !inst["fx"]["fxFretNoise"].is_array())
                continue;
            const auto& arr = inst["fx"]["fxFretNoise"];
            const int n = (int)arr.size();
            if (n == 0) continue;

            auto decoded = decodeCached(rel, st);
            if (!decoded || !decoded->ok || decoded->sampleRate <= 0) { st.fretMissing += n; continue; }
            const double totalSec = decoded->buffer.getNumSamples() / decoded->sampleRate;
            if (!(totalSec > 0)) { st.fretMissing += n; continue; }
            const double sliceSec = totalSec / n;
            for (int i = 0; i < n; ++i) {
                if (!arr[i].is_number()) { st.fretMissing++; continue; }
                const int id = (int)arr[i].get<double>();
                mixer.setSample(std::to_string(id), makeSamplerSlice(*decoded, i * sliceSec, (i + 1) * sliceSec));
                st.fretSlots++;
            }
        }
    }

    // ---- guitar strums: one pre-sliced chord/fx mp3 per pool entry ---------
    // Mirrors prestage-samples.mjs + lib/stage-guitar-strums.mjs (docs/54v):
    // virtualGuitaristSamples[] entries resolve to a per-(chord,pos,type) file under
    // manifest.Guitar.chordsAbsDir (chord root translated sharp->disk via
    // engineChordToDiskChord), or a per-fx file under fxAbsDir. Both dirs are
    // ABSOLUTE (already resolved against the library root by the manifest builder).
    // Each entry binds whole by its id (decimal key) — the key Mixer::strumNoteToId
    // resolves a strum note to.
    void loadStrums(Mixer& mixer, const nlohmann::json& manifest,
                    const std::vector<nlohmann::json>& instJsons, SampleLibraryStats& st) {
        if (!manifest.contains("Guitar")) return;
        const auto& g = manifest["Guitar"];
        const std::string chordsDir = g.value("chordsAbsDir", std::string());
        const std::string fxDir = g.value("fxAbsDir", std::string());

        for (const auto& inst : instJsons) {
            if (!isGuitar(inst)) continue;
            if (!inst.contains("virtualGuitaristSamples")
                || !inst["virtualGuitaristSamples"].is_array())
                continue;
            for (const auto& e : inst["virtualGuitaristSamples"]) {
                const int id = e.value("id", -1);
                if (id < 0) continue;
                const std::string fx = (e.contains("fx") && e["fx"].is_string())
                    ? e["fx"].get<std::string>() : std::string();
                std::string abs;
                if (!fx.empty()) {
                    if (fxDir.empty()) { st.strumMissing++; continue; }
                    abs = fxDir + "/" + fx + ".mp3";
                } else {
                    if (chordsDir.empty()) { st.strumMissing++; continue; }
                    const std::string base = chordFileBasename(
                        engineChordToDiskChord(e.value("chord", std::string())),
                        chordPositionStr(e),
                        e.value("type", std::string()));
                    if (base.empty()) { st.strumMissing++; continue; }
                    abs = chordsDir + "/" + base;
                }
                if (!std::filesystem::exists(abs)) { st.strumMissing++; continue; }
                auto decoded = decodeCached(abs, st);  // abs path: path(root_)/abs == abs
                if (!decoded || !decoded->ok) { st.strumMissing++; continue; }
                mixer.setSample(std::to_string(id), makeSamplerWhole(*decoded));
                st.strumSamples++;
            }
        }
    }

    static bool isGuitar(const nlohmann::json& inst) {
        const std::string t = inst.value("type", std::string());
        return t == "acousticGuitars" || t == "electricGuitars";
    }

    // chordPosition is "1" (string) in the inst json; the resolver's key uses the
    // int form, but the legacy filename uses the verbatim string (stage-guitar-
    // strums chordFileBasename uses String(chordPosition)). Mirror that string.
    static std::string chordPositionStr(const nlohmann::json& e) {
        if (!e.contains("chordPosition")) return "1";
        const auto& v = e["chordPosition"];
        if (v.is_string()) return v.get<std::string>();
        if (v.is_number()) return std::to_string((int)v.get<double>());
        return "1";
    }

    // lib/guitar-chord-alias.mjs::engineChordToDiskChord — translate a chord
    // symbol's accidental ROOT to the library's per-accidental disk spelling
    // (A#->Bb, D#->Eb, G#->Ab; C#/F# unchanged), suffix preserved. Naturals and
    // unknown roots pass through verbatim.
    static std::string engineChordToDiskChord(const std::string& chord) {
        if (chord.size() < 2) return chord;
        const char letter = chord[0];
        const char acc = chord[1];
        if (letter < 'A' || letter > 'G' || (acc != '#' && acc != 'b')) return chord;
        const std::string suffix = chord.substr(2);
        std::string diskRoot;
        switch (letter) {
            case 'A': diskRoot = (acc == '#') ? "Bb" : chord.substr(0, 2); break;
            case 'B': diskRoot = (acc == '#') ? "C"  : chord.substr(0, 2); break;
            case 'C': diskRoot = (acc == '#') ? "C#" : chord.substr(0, 2); break;
            case 'D': diskRoot = (acc == '#') ? "Eb" : chord.substr(0, 2); break;
            case 'E': diskRoot = (acc == '#') ? "F"  : chord.substr(0, 2); break;
            case 'F': diskRoot = (acc == '#') ? "F#" : chord.substr(0, 2); break;
            case 'G': diskRoot = (acc == '#') ? "Ab" : chord.substr(0, 2); break;
            default: return chord;
        }
        return diskRoot + suffix;
    }

    // lib/stage-guitar-strums.mjs::{chordTypeToFileSuffix,chordFileBasename}:
    //   ("C","1","chordLongStrumDown")   -> "C _ Pos 1 _ Long Strum Down.mp3"
    //   ("F#m","3","chordShortStrumUp")  -> "F#m _ Pos 3 _ Short Strum Up.mp3"
    // Returns "" for an unrecognised type (no chord(Long|Short)Strum(Up|Down) match).
    static std::string chordFileBasename(const std::string& chord, const std::string& pos,
                                         const std::string& type) {
        std::string lenWord, dirWord;
        if (type == "chordLongStrumDown")       { lenWord = "Long";  dirWord = "Down"; }
        else if (type == "chordLongStrumUp")    { lenWord = "Long";  dirWord = "Up"; }
        else if (type == "chordShortStrumDown") { lenWord = "Short"; dirWord = "Down"; }
        else if (type == "chordShortStrumUp")   { lenWord = "Short"; dirWord = "Up"; }
        else return std::string();
        return chord + " _ Pos " + pos + " _ " + lenWord + " Strum " + dirWord + ".mp3";
    }

    // ---- decode cache (one decode per file, shared across slots) -----------
    std::shared_ptr<DecodedAudio> decodeCached(const std::string& rel, SampleLibraryStats& st) {
        auto it = cache_.find(rel);
        if (it != cache_.end()) return it->second;
        const std::string abs = (std::filesystem::path(root_) / rel).string();
        const std::string prepared = prepareNormalizedSource(abs);
        auto dec = std::make_shared<DecodedAudio>(decodeAudioFile(prepared));
        if (dec->ok) st.filesDecoded++; else st.decodeFailures++;
        cache_[rel] = dec;
        return dec;
    }

    static std::string fileExtLower(const std::string& path) {
        const auto dot = path.find_last_of('.');
        if (dot == std::string::npos) return std::string();
        std::string ext = path.substr(dot + 1);
        for (char& c : ext) c = (char)((c >= 'A' && c <= 'Z') ? c - 'A' + 'a' : c);
        return ext;
    }

    static bool isNativeAudioFormat(const std::string& path) {
        const std::string ext = fileExtLower(path);
        return ext == "ogg" || ext == "oga" || ext == "wav" || ext == "wave";
    }

    static std::string shellQuote(const std::string& s) {
        std::string out = "'";
        for (char c : s) {
            if (c == '\'') out += "'\\''";
            else out += c;
        }
        out += "'";
        return out;
    }

    static std::string safeBaseName(const std::filesystem::path& p) {
        std::string base = p.filename().string();
        for (char& c : base) {
            const bool ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')
                         || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-';
            if (!ok) c = '_';
        }
        return base;
    }

    static uint32_t fnv1a32(const std::string& s) {
        uint32_t h = 0x811c9dc5u;
        for (unsigned char c : s) {
            h ^= c;
            h *= 0x01000193u;
        }
        return h;
    }

    static long long fileMtimeMsRounded(const std::filesystem::path& p) {
        namespace chr = std::chrono;
        const auto ft = std::filesystem::last_write_time(p);
        const auto st = chr::time_point_cast<chr::milliseconds>(
            ft - std::filesystem::file_time_type::clock::now() + chr::system_clock::now());
        return st.time_since_epoch().count();
    }

    static std::string hex8(uint32_t v) {
        static const char* digits = "0123456789abcdef";
        std::string s(8, '0');
        for (int i = 7; i >= 0; --i) {
            s[(size_t)i] = digits[v & 0x0f];
            v >>= 4;
        }
        return s;
    }

    static std::filesystem::path defaultCacheRoot(const std::filesystem::path& genreDir) {
        if (const char* env = std::getenv("CASPERAKI_AUDIO_CACHE_ROOT"))
            if (*env) return std::filesystem::path(env);
        if (std::filesystem::exists("/mnt/d"))
            return std::filesystem::path("/mnt/d/casperaki-cache/audio-normalized");

        std::filesystem::path engineSpike = std::filesystem::absolute(genreDir);
        for (int i = 0; i < 3 && !engineSpike.empty(); ++i)
            engineSpike = engineSpike.parent_path();
        return engineSpike / ".cache" / "audio-normalized";
    }

    std::filesystem::path resolveAudioCacheRoot(const std::filesystem::path& genreDir) const {
        std::error_code ec;
        auto root = defaultCacheRoot(genreDir);
        std::filesystem::create_directories(root, ec);
        return root;
    }

    std::string normalizedCachePath(const std::string& abs) const {
        const std::filesystem::path p = std::filesystem::absolute(abs);
        std::error_code ec;
        const auto size = std::filesystem::file_size(p, ec);
        if (ec) return std::string();
        const auto mtimeMs = fileMtimeMsRounded(p);
        const std::string path = p.string();
        return (cacheRoot_ / (safeBaseName(p) + "." + hex8(fnv1a32(path)) + "."
                             + std::to_string(size) + "." + std::to_string(mtimeMs)
                             + ".ogg")).string();
    }

    std::string prepareNormalizedSource(const std::string& abs) const {
        if (isNativeAudioFormat(abs)) return abs;
        if (!std::filesystem::exists(abs)) return abs;

        const std::string prepared = normalizedCachePath(abs);
        if (prepared.empty()) return abs;
        std::error_code ec;
        if (std::filesystem::exists(prepared, ec) && std::filesystem::file_size(prepared, ec) > 0)
            return prepared;

        std::filesystem::create_directories(std::filesystem::path(prepared).parent_path(), ec);
        const std::string cmd = "ffmpeg -y -hide_banner -loglevel error -i " + shellQuote(abs)
                              + " -ac 2 -ar 44100 -c:a libvorbis -q:a 5 "
                              + shellQuote(prepared);
        const int rc = std::system(cmd.c_str());
        if (rc == 0 && std::filesystem::exists(prepared, ec)
            && std::filesystem::file_size(prepared, ec) > 0)
            return prepared;
        // No silent fall-back to the raw MP3: minimp3 does not trim the encoder
        // delay, so that path plays every slice ~51 ms late (docs/67 #13).
        throw std::runtime_error("SampleLibrary: ffmpeg could not convert " + abs + " to " + prepared
                                 + " (exit " + std::to_string(rc) + ")");
    }

    // ---- PCM -> padded SampleData -----------------------------------------
    std::shared_ptr<SampleData> makeSamplerWhole(const DecodedAudio& dec) const {
        return makeRange(dec, 0, dec.buffer.getNumSamples(), true);
    }

    std::shared_ptr<SampleData> makeSlice(const DecodedAudio& dec, double startSec, double endSec) const {
        return makeSamplerSlice(dec, startSec, endSec);
    }

    std::shared_ptr<SampleData> makeSamplerSlice(const DecodedAudio& dec, double startSec, double endSec) const {
        const int total = dec.buffer.getNumSamples();
        long lo = (long)std::llround(startSec * dec.sampleRate);
        long hi = (long)std::llround(endSec * dec.sampleRate);
        lo = std::max(0L, std::min(lo, (long)total));
        hi = std::max(lo, std::min(hi, (long)total));
        return makeRange(dec, (int)lo, (int)hi, true);
    }

    std::shared_ptr<SampleData> makeWaveWhole(const DecodedAudio& dec) const {
        return makeRange(dec, 0, dec.buffer.getNumSamples(), false);
    }

    // Copy [from,to) of every channel into a fresh SampleData with the trailing
    // zero pad the sampler's Lagrange lookahead / pitch-up overshoot needs.
    std::shared_ptr<SampleData> makeRange(const DecodedAudio& dec, int from, int to,
                                          bool applySamplerFade) const {
        auto data = std::make_shared<SampleData>();
        const int ch = std::max(1, dec.buffer.getNumChannels());
        const int frames = std::max(0, to - from);
        data->audio.setSize(ch, frames + pad_);
        for (int c = 0; c < dec.buffer.getNumChannels(); ++c)
            if (frames > 0)
                data->audio.copyFrom(c, 0, dec.buffer, c, from, frames);
        data->frames = frames;
        data->sampleRate = dec.sampleRate;

        // te::SamplerPlugin::SamplerSound::setExcerpt bakes a 30-sample concave
        // anti-click fade-in into each loaded sample IF it starts loud (any
        // channel's first frame |x| > 0.01). This is the ONLY onset shaping the
        // native engine applies — there is no per-voice ADSR (config.h
        // USE_TE_SAMPLER). AudioFadeCurve::concave over [0,fadeLen):
        //   gain(i) = 1 - cos(i * (pi/2) / fadeLen)   (delta = (pi/2)/fadeLen).
        if (applySamplerFade && frames > 0) {
            int fadeLen = 0;
            for (int c = 0; c < ch; ++c)
                if (std::abs(data->audio.getReadPointer(c)[0]) > 0.01f) fadeLen = 30;
            fadeLen = std::min(fadeLen, frames);
            if (fadeLen > 0) {
                constexpr float kHalfPi = 1.57079632679489661923f;
                const float step = kHalfPi / (float)fadeLen;
                for (int c = 0; c < ch; ++c) {
                    float* d = data->audio.getWritePointer(c);
                    for (int i = 0; i < fadeLen; ++i)
                        d[i] *= 1.0f - std::cos((float)i * step);
                }
            }
        }
        return data;
    }

    // manifest.lanes[name] (covers duplicate-family lanes) else top-level family.
    static const nlohmann::json* laneEntry(const nlohmann::json& manifest, const std::string& name) {
        if (manifest.contains("lanes") && manifest["lanes"].is_object()
            && manifest["lanes"].contains(name))
            return &manifest["lanes"][name];
        if (manifest.contains(name)) return &manifest[name];
        return nullptr;
    }

    std::string root_;
    int pad_;
    std::filesystem::path cacheRoot_;
    std::unordered_map<std::string, std::shared_ptr<DecodedAudio>> cache_;
};

} // namespace casperaki
