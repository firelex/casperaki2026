// WASM entry point for the resolution engine. Exposes `resolve()` to JS: the
// browser passes the song.json + inst-N.json texts (fetched from the backend),
// gets back the resolved-events/v1 JSON. This is the resolution half of the
// engine; the sampler/mix half (Phase 1 step 3) renders audio from this IR in
// the AudioWorklet.
//
// Built with emscripten as a standard (non-standalone) module here because it
// uses std::filesystem-free C++ + the JS string marshalling helpers; the
// audio DSP module stays standalone/import-free (tone.c lineage). See
// build-wasm.sh.

#include "Resolver.h"
#include "Serialize.h"

#include <string>
#include <vector>

#ifdef __EMSCRIPTEN__
#include <emscripten/bind.h>

// Marshalled via embind: song JSON text + a JS array of inst JSON texts ->
// resolved-events/v1 JSON text.
static std::string resolveSong(const std::string& songJson,
                               const std::vector<std::string>& instJsons) {
    casperaki::Resolver resolver;
    const auto ev = resolver.resolve(songJson, instJsons);
    return casperaki::toResolvedEventsV1(ev).dump();
}

EMSCRIPTEN_BINDINGS(casperaki_engine) {
    emscripten::register_vector<std::string>("StringList");
    emscripten::function("resolveSong", &resolveSong);
}
#endif
