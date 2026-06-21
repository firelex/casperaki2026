// Minimal WAV writer for the offline render driver (the headline out.wav per
// genre). 16-bit PCM, interleaved, little-endian — the universally playable
// shape. This is an adapter concern: the sampler/mix core works entirely in
// float AudioBuffer; only the final master is quantised here on the way to disk.
#pragma once

#include "AudioBuffer.h"

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <string>

namespace casperaki {

inline void putU32(std::FILE* f, uint32_t v) {
    uint8_t b[4] = {(uint8_t)(v), (uint8_t)(v >> 8), (uint8_t)(v >> 16), (uint8_t)(v >> 24)};
    std::fwrite(b, 1, 4, f);
}
inline void putU16(std::FILE* f, uint16_t v) {
    uint8_t b[2] = {(uint8_t)(v), (uint8_t)(v >> 8)};
    std::fwrite(b, 1, 2, f);
}

// Write a stereo (or mono) float buffer to a 16-bit PCM WAV. Samples are
// clamped to [-1, 1] then scaled to int16. Returns false on file-open failure.
inline bool writeWav16(const std::string& path, const AudioBuffer& buf, int sampleRate) {
    const int numChannels = std::max(1, buf.getNumChannels());
    const int numFrames = buf.getNumSamples();
    const int bytesPerSample = 2;
    const uint32_t dataBytes = (uint32_t)numFrames * numChannels * bytesPerSample;

    std::FILE* f = std::fopen(path.c_str(), "wb");
    if (!f) return false;

    std::fwrite("RIFF", 1, 4, f);
    putU32(f, 36 + dataBytes);
    std::fwrite("WAVE", 1, 4, f);

    std::fwrite("fmt ", 1, 4, f);
    putU32(f, 16);                                   // PCM fmt chunk size
    putU16(f, 1);                                    // audioFormat = PCM
    putU16(f, (uint16_t)numChannels);
    putU32(f, (uint32_t)sampleRate);
    putU32(f, (uint32_t)(sampleRate * numChannels * bytesPerSample)); // byte rate
    putU16(f, (uint16_t)(numChannels * bytesPerSample));              // block align
    putU16(f, 16);                                   // bits per sample

    std::fwrite("data", 1, 4, f);
    putU32(f, dataBytes);

    for (int i = 0; i < numFrames; ++i) {
        for (int ch = 0; ch < numChannels; ++ch) {
            float s = buf.getReadPointer(ch)[i];
            s = std::max(-1.0f, std::min(1.0f, s));
            const int16_t q = (int16_t)std::lround(s * 32767.0f);
            putU16(f, (uint16_t)q);
        }
    }

    std::fclose(f);
    return true;
}

// Write a stereo (or mono) float buffer to a 24-bit PCM WAV (matches the native
// golden's depth — useful for A/B and for a cleaner master). Samples clamp to
// [-1,1] then scale to int24 (3 little-endian bytes per sample).
inline bool writeWav24(const std::string& path, const AudioBuffer& buf, int sampleRate) {
    const int numChannels = std::max(1, buf.getNumChannels());
    const int numFrames = buf.getNumSamples();
    const int bytesPerSample = 3;
    const uint32_t dataBytes = (uint32_t)numFrames * numChannels * bytesPerSample;

    std::FILE* f = std::fopen(path.c_str(), "wb");
    if (!f) return false;

    std::fwrite("RIFF", 1, 4, f);
    putU32(f, 36 + dataBytes);
    std::fwrite("WAVE", 1, 4, f);

    std::fwrite("fmt ", 1, 4, f);
    putU32(f, 16);
    putU16(f, 1);                                    // PCM
    putU16(f, (uint16_t)numChannels);
    putU32(f, (uint32_t)sampleRate);
    putU32(f, (uint32_t)(sampleRate * numChannels * bytesPerSample));
    putU16(f, (uint16_t)(numChannels * bytesPerSample));
    putU16(f, 24);                                   // bits per sample

    std::fwrite("data", 1, 4, f);
    putU32(f, dataBytes);

    for (int i = 0; i < numFrames; ++i) {
        for (int ch = 0; ch < numChannels; ++ch) {
            float s = buf.getReadPointer(ch)[i];
            s = std::max(-1.0f, std::min(1.0f, s));
            const int32_t q = (int32_t)std::lround(s * 8388607.0f);
            uint8_t b[3] = {(uint8_t)(q), (uint8_t)(q >> 8), (uint8_t)(q >> 16)};
            std::fwrite(b, 1, 3, f);
        }
    }

    std::fclose(f);
    return true;
}

} // namespace casperaki
