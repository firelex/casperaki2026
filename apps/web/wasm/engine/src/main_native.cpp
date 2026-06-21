// Native CLI driver for the WASM resolution engine — the test/validation entry
// point (the browser uses main_wasm.cpp). Reads a genre envelope directory
// (song.json + inst-N.json, same layout the native harness consumes) and prints
// the resolved-events/v1 JSON to stdout, so scripts/validate-resolution.mjs can
// diff it against the native oracle dump.
//
//   usage: casperaki_resolve <envelope-dir>

#include "Resolver.h"
#include "Serialize.h"

#include <algorithm>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

namespace fs = std::filesystem;

static std::string readFile(const fs::path& p) {
    std::ifstream f(p, std::ios::binary);
    if (!f) throw std::runtime_error("cannot open " + p.string());
    std::stringstream ss; ss << f.rdbuf();
    return ss.str();
}

int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "usage: casperaki_resolve <envelope-dir>\n";
        return 2;
    }
    const fs::path dir = fs::absolute(argv[1]);

    std::string songJson;
    try {
        songJson = readFile(dir / "song.json");
    } catch (const std::exception& e) {
        std::cerr << "error: " << e.what() << "\n";
        return 2;
    }

    // Collect inst-N.json in ascending numeric id order, matching the native
    // harness add order (harness.cpp:133-139).
    std::vector<fs::path> instPaths;
    for (const auto& e : fs::directory_iterator(dir)) {
        const auto name = e.path().filename().string();
        if (name.rfind("inst-", 0) == 0 && e.path().extension() == ".json")
            instPaths.push_back(e.path());
    }
    std::sort(instPaths.begin(), instPaths.end(),
              [](const fs::path& a, const fs::path& b) {
                  auto n = [](const fs::path& p) {
                      return std::stoi(p.stem().string().substr(5));
                  };
                  return n(a) < n(b);
              });

    std::vector<std::string> instJsons;
    instJsons.reserve(instPaths.size());
    for (const auto& p : instPaths) instJsons.push_back(readFile(p));

    try {
        casperaki::Resolver resolver;
        const auto ev = resolver.resolve(songJson, instJsons);
        std::cout << casperaki::toResolvedEventsV1(ev).dump() << std::endl;
    } catch (const std::exception& e) {
        std::cerr << "resolve error: " << e.what() << "\n";
        return 1;
    }
    return 0;
}
