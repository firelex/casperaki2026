// OGG Vorbis decode adapter for the NATIVE test/render path. The sampler/mix
// core (Sampler.h) consumes already-decoded float PCM in an AudioBuffer; this
// adapter is the only place that knows the on-disk codec, so the browser path
// can swap in WebAudio decodeAudioData and feed the same AudioBuffer.
//
// Backed by the vendored public-domain stb_vorbis (vendor/stb_vorbis.c, compiled
// as its own TU). We declare only the one entry point we use and convert its
// interleaved int16 output into a planar float AudioBuffer.
#pragma once

#include "AudioBuffer.h"

#include <cstdint>
#include <cstdlib>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

extern "C" {
// stb_vorbis_decode_memory: decode an entire OGG file held in memory. Returns
// the number of samples PER CHANNEL (frames), or -1 on error. *output is a
// malloc'd interleaved int16 buffer (channels * frames) the caller must free.
int stb_vorbis_decode_memory(const unsigned char* mem, int len, int* channels,
                             int* sample_rate, short** output);
}

namespace casperaki {

struct DecodedAudio {
    AudioBuffer buffer;       // planar float, [-1, 1]
    int sampleRate = 0;
    bool ok = false;
};

// Decode an .ogg file at `path` into a planar float AudioBuffer. Mono sources
// stay one channel; the sampler duplicates as needed (it reads channel
// min(i, numCh-1)).
inline DecodedAudio decodeOggFile(const std::string& path) {
    DecodedAudio out;

    std::ifstream f(path, std::ios::binary);
    if (!f) return out;
    std::stringstream ss;
    ss << f.rdbuf();
    const std::string bytes = ss.str();
    if (bytes.empty()) return out;

    int channels = 0, sampleRate = 0;
    short* pcm = nullptr;
    const int frames = stb_vorbis_decode_memory(
        reinterpret_cast<const unsigned char*>(bytes.data()),
        (int)bytes.size(), &channels, &sampleRate, &pcm);

    if (frames < 0 || pcm == nullptr || channels <= 0) {
        if (pcm) std::free(pcm);
        return out;
    }

    out.buffer.setSize(channels, frames);
    for (int ch = 0; ch < channels; ++ch) {
        float* dst = out.buffer.getWritePointer(ch);
        for (int i = 0; i < frames; ++i)
            dst[i] = pcm[i * channels + ch] * (1.0f / 32768.0f);
    }
    std::free(pcm);

    out.sampleRate = sampleRate;
    out.ok = true;
    return out;
}

} // namespace casperaki
