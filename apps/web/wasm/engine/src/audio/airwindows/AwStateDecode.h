// Decode a PresetManager AirWindows `state="<size>.<base64>"` chunk into the
// plugin's [0,1] parameter array. Faithful C++ port of
// tools/decode-airwindows-state.mjs (validated against the real rack chunks).
//
// The string is a JUCE MemoryBlock base64 (alphabet '.' A-Z a-z 0-9 '+', packed
// LSB-first per MemoryBlock::setBitRange). Decoded bytes are an FXB-wrapped chunk:
// a 160-byte header then N little-endian float32 params (size = 160 + 4*N).
#pragma once

#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

namespace casperaki {
namespace aw {

// Decode the JUCE MemoryBlock "<size>.<base64>" into raw bytes (length == size).
inline std::vector<uint8_t> decodeJuceMemoryBlock(const std::string& s) {
    static const char* kAlphabet = ".ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+";
    int8_t rev[128];
    std::memset(rev, -1, sizeof(rev));
    for (int i = 0; kAlphabet[i]; ++i) rev[(int)kAlphabet[i]] = (int8_t)i;

    const auto dot = s.find('.');
    if (dot == std::string::npos) return {};
    const int size = std::stoi(s.substr(0, dot));
    std::vector<uint8_t> out((size_t)std::max(0, size), 0);

    int bitPos = 0;
    for (size_t i = dot + 1; i < s.size(); ++i) {
        const char ch = s[i];
        if ((unsigned char)ch >= 128 || rev[(int)ch] < 0) continue;
        int value = rev[(int)ch], numBits = 6;
        while (numBits > 0) {                       // mirror MemoryBlock::setBitRange (LSB-first)
            const int byte = bitPos >> 3, off = bitPos & 7;
            if (byte >= size) { numBits = 0; break; }
            const int bitsThisTime = (numBits < 8 - off) ? numBits : 8 - off;
            const int mask = (1 << bitsThisTime) - 1;
            out[(size_t)byte] |= (uint8_t)((value & mask) << off);
            value >>= bitsThisTime;
            bitPos += bitsThisTime;
            numBits -= bitsThisTime;
        }
    }
    return out;
}

// Decode -> the N float32 params after the 160-byte FXB header.
inline std::vector<float> decodeAwParams(const std::string& state, int headerBytes = 160) {
    const std::vector<uint8_t> buf = decodeJuceMemoryBlock(state);
    std::vector<float> params;
    if ((int)buf.size() <= headerBytes) return params;
    const int n = (int)(buf.size() - headerBytes) / 4;
    params.resize((size_t)n);
    for (int i = 0; i < n; ++i) {
        float f;
        std::memcpy(&f, buf.data() + headerBytes + i * 4, 4);  // little-endian host (x86/wasm)
        params[(size_t)i] = f;
    }
    return params;
}

} // namespace aw
} // namespace casperaki
