// WAV file reading and a throwing 24-bit PCM writer, used by the mastering CLI
// (main_master.cpp). (The engine's writeWav24 in WavIO.h reports failure by return value
// and stays as it is for the render path.)
//
// Reading: 16-bit PCM -> int16 / 32768, 24-bit PCM -> int24 / 8388608 (exact in float),
// 32-bit float taken as is. Anything else throws.
#pragma once

#include "AudioBuffer.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

namespace casperaki {

struct WavData {
    AudioBuffer buffer;
    int sampleRate = 0;
    int bitsPerSample = 0;
    bool isFloat = false;
};

inline WavData readWavFile(const std::string& path) {
    std::FILE* f = std::fopen(path.c_str(), "rb");
    if (!f) throw std::runtime_error("readWavFile: cannot open " + path);
    std::vector<uint8_t> bytes;
    {
        std::fseek(f, 0, SEEK_END);
        const long len = std::ftell(f);
        std::fseek(f, 0, SEEK_SET);
        if (len < 12) { std::fclose(f); throw std::runtime_error("readWavFile: file too short: " + path); }
        bytes.resize(static_cast<size_t>(len));
        const size_t got = std::fread(bytes.data(), 1, bytes.size(), f);
        std::fclose(f);
        if (got != bytes.size()) throw std::runtime_error("readWavFile: short read: " + path);
    }
    auto u16 = [&](size_t o) { return (uint32_t)bytes[o] | ((uint32_t)bytes[o + 1] << 8); };
    auto u32 = [&](size_t o) { return u16(o) | (u16(o + 2) << 16); };
    if (std::memcmp(bytes.data(), "RIFF", 4) != 0 || std::memcmp(bytes.data() + 8, "WAVE", 4) != 0)
        throw std::runtime_error("readWavFile: not a RIFF/WAVE file: " + path);

    int format = -1, channels = 0, rate = 0, bits = 0;
    size_t dataOff = 0, dataLen = 0;
    bool haveData = false;
    for (size_t off = 12; off + 8 <= bytes.size();) {
        const uint32_t len = u32(off + 4);
        if (std::memcmp(bytes.data() + off, "fmt ", 4) == 0) {
            if (len < 16 || off + 8 + 16 > bytes.size()) throw std::runtime_error("readWavFile: bad fmt chunk: " + path);
            format = (int)u16(off + 8);
            channels = (int)u16(off + 10);
            rate = (int)u32(off + 12);
            bits = (int)u16(off + 22);
            if (format == 0xFFFE && len >= 40) format = (int)u16(off + 8 + 24);  // WAVE_FORMAT_EXTENSIBLE subformat
        } else if (std::memcmp(bytes.data() + off, "data", 4) == 0) {
            dataOff = off + 8;
            dataLen = std::min<size_t>(len, bytes.size() - dataOff);
            haveData = true;
            break;
        }
        off += 8 + len + (len & 1u);
    }
    if (format < 0 || !haveData) throw std::runtime_error("readWavFile: missing fmt or data chunk: " + path);
    if (channels <= 0) throw std::runtime_error("readWavFile: no channels: " + path);
    const bool isFloat = (format == 3);
    if (!((format == 1 && (bits == 16 || bits == 24)) || (isFloat && bits == 32)))
        throw std::runtime_error("readWavFile: unsupported format " + std::to_string(format) + "/" +
                                 std::to_string(bits) + "-bit (want 16/24-bit PCM or 32-bit float): " + path);

    const int bytesPerSample = bits / 8;
    const size_t numFrames = dataLen / ((size_t)bytesPerSample * (size_t)channels);
    if (numFrames > (size_t)std::numeric_limits<int>::max()) throw std::runtime_error("readWavFile: too long: " + path);

    WavData out;
    out.sampleRate = rate;
    out.bitsPerSample = bits;
    out.isFloat = isFloat;
    out.buffer.setSize(channels, (int)numFrames);
    const uint8_t* p = bytes.data() + dataOff;
    for (size_t i = 0; i < numFrames; ++i) {
        for (int ch = 0; ch < channels; ++ch) {
            const uint8_t* s = p + (i * (size_t)channels + (size_t)ch) * (size_t)bytesPerSample;
            float v;
            if (isFloat) {
                std::memcpy(&v, s, 4);
            } else if (bits == 16) {
                const int16_t q = (int16_t)(uint16_t)(s[0] | (s[1] << 8));
                v = (float)q / 32768.0f;
            } else {
                uint32_t u = (uint32_t)s[0] | ((uint32_t)s[1] << 8) | ((uint32_t)s[2] << 16);
                if (u & 0x800000u) u |= 0xff000000u;  // sign-extend 24 -> 32 bits
                v = (float)(int32_t)u / 8388608.0f;
            }
            out.buffer.getWritePointer(ch)[i] = v;
        }
    }
    return out;
}

// float -> 24-bit integer: scale by 2^23, round to nearest, clamp to [-2^23, 2^23 - 1].
inline int32_t floatToInt24(float sample) {
    const double scaled = std::round((double)sample * 8388608.0);
    return (int32_t)std::max(-8388608.0, std::min(8388607.0, scaled));
}

// 24-bit PCM WAV writer; throws on any failure.
inline void writeWav24File(const std::string& path, const AudioBuffer& buf, int sampleRate) {
    const int numChannels = buf.getNumChannels();
    const int numFrames = buf.getNumSamples();
    if (numChannels <= 0) throw std::invalid_argument("writeWav24File: no channels");
    const uint32_t dataBytes = (uint32_t)numFrames * (uint32_t)numChannels * 3u;
    std::vector<uint8_t> out;
    out.reserve(44 + dataBytes);
    auto put16 = [&](uint32_t v) { out.push_back((uint8_t)v); out.push_back((uint8_t)(v >> 8)); };
    auto put32 = [&](uint32_t v) { put16(v & 0xffff); put16(v >> 16); };
    auto tag = [&](const char* t) { out.insert(out.end(), t, t + 4); };
    tag("RIFF"); put32(36 + dataBytes); tag("WAVE");
    tag("fmt "); put32(16); put16(1); put16((uint32_t)numChannels); put32((uint32_t)sampleRate);
    put32((uint32_t)sampleRate * (uint32_t)numChannels * 3u); put16((uint32_t)numChannels * 3u); put16(24);
    tag("data"); put32(dataBytes);
    for (int i = 0; i < numFrames; ++i)
        for (int ch = 0; ch < numChannels; ++ch) {
            const int32_t q = floatToInt24(buf.getReadPointer(ch)[i]);
            out.push_back((uint8_t)q); out.push_back((uint8_t)(q >> 8)); out.push_back((uint8_t)(q >> 16));
        }
    std::FILE* f = std::fopen(path.c_str(), "wb");
    if (!f) throw std::runtime_error("writeWav24File: cannot open " + path);
    const size_t wrote = std::fwrite(out.data(), 1, out.size(), f);
    const int closed = std::fclose(f);
    if (wrote != out.size() || closed != 0) throw std::runtime_error("writeWav24File: write failed: " + path);
}

} // namespace casperaki
