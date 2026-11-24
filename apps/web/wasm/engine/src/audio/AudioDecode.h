// Native audio-file decode dispatch (docs/60 Phase 1 finish — real sample
// library). The sampler/mix core (Sampler.h / Mixer.h) consumes already-decoded
// planar float PCM; this adapter is the native side that knows the on-disk
// codecs, so the browser path can swap in WebAudio decodeAudioData and feed the
// same AudioBuffer. NEVER included by the mixer or the wasm entry point — only
// by the native render driver / validation tools (it links minimp3 + stb_vorbis).
//
//   .mp3  -> vendored minimp3 (the codec the legacy casperaki_engine used)
//   .ogg  -> vendored stb_vorbis (OggDecode.h, the stub-fixture path)
//
// The real library is .mp3; the bundled stub fixtures are .ogg. Both land in the
// same DecodedAudio (planar float, source sample rate preserved — the sampler
// resamples by fileSR/engineSR, so we keep the native rate rather than resample).
#pragma once

#include "AudioBuffer.h"
#include "OggDecode.h"          // DecodedAudio + decodeOggFile (stb_vorbis)

// minimp3 emits int16 by default; MINIMP3_FLOAT_OUTPUT switches mp3d_sample_t to
// float [-1,1]. It MUST be defined identically here and in the implementation TU
// (vendor/minimp3_impl.c) — otherwise mp3d_sample_t differs across TUs (float vs
// int16), so the decoder writes float frames into a smaller int16 PCM buffer:
// a stack overflow + garbage scale. Keep these two defines in lockstep.
#define MINIMP3_FLOAT_OUTPUT
#include "../../vendor/minimp3.h"

#include <algorithm>
#include <cstdint>
#include <fstream>
#include <cstring>
#include <sstream>
#include <string>
#include <vector>

namespace casperaki {

struct Mp3GaplessTrim {
    int leading = 0;
    int trailing = 0;
};

inline int id3v2TagBytes(const uint8_t* bytes, size_t size) {
    if (size < 10 || std::memcmp(bytes, "ID3", 3) != 0) return 0;
    const int flags = bytes[5];
    const int payload = ((bytes[6] & 0x7f) << 21)
                      | ((bytes[7] & 0x7f) << 14)
                      | ((bytes[8] & 0x7f) << 7)
                      |  (bytes[9] & 0x7f);
    return 10 + payload + ((flags & 0x10) ? 10 : 0);
}

inline bool isMpegHeader(const uint8_t* h) {
    if (h[0] != 0xff || (h[1] & 0xe0) != 0xe0) return false;
    const int version = (h[1] >> 3) & 0x03;
    const int layer = (h[1] >> 1) & 0x03;
    const int bitrate = (h[2] >> 4) & 0x0f;
    const int sampleRate = (h[2] >> 2) & 0x03;
    return version != 1 && layer != 0 && bitrate != 0 && bitrate != 0x0f && sampleRate != 0x03;
}

inline Mp3GaplessTrim readMp3GaplessTrim(const std::string& bytes) {
    Mp3GaplessTrim trim;
    const auto* data = reinterpret_cast<const uint8_t*>(bytes.data());
    const size_t size = bytes.size();
    size_t pos = (size_t)std::max(0, id3v2TagBytes(data, size));

    while (pos + 4 < size && !isMpegHeader(data + pos)) ++pos;
    if (pos + 4 >= size) return trim;

    const uint8_t* h = data + pos;
    const int version = (h[1] >> 3) & 0x03;      // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
    const int channelMode = (h[3] >> 6) & 0x03;  // 3=mono
    const bool mono = channelMode == 3;
    const int sideInfoBytes = version == 3 ? (mono ? 17 : 32) : (mono ? 9 : 17);
    const size_t xing = pos + 4 + (size_t)sideInfoBytes;
    if (xing + 0x3c >= size) return trim;
    if (std::memcmp(data + xing, "Xing", 4) != 0 && std::memcmp(data + xing, "Info", 4) != 0)
        return trim;

    // LAME/Xing stores encoder delay + end padding as two 12-bit values in the
    // three bytes at LAME-tag offset 0x15. The LAME tag starts 0x24 bytes after
    // the Xing/Info marker in the first audio frame.
    const size_t delayPadding = xing + 0x24 + 0x15;
    if (delayPadding + 3 > size) return trim;
    const uint8_t b0 = data[delayPadding], b1 = data[delayPadding + 1], b2 = data[delayPadding + 2];
    const int leading = ((int)b0 << 4) | ((int)b1 >> 4);
    const int trailing = (((int)b1 & 0x0f) << 8) | (int)b2;
    if (leading < 0 || leading > 4095 || trailing < 0 || trailing > 4095) return trim;
    trim.leading = leading;
    trim.trailing = trailing;
    return trim;
}

// Decode an entire .mp3 into a planar float DecodedAudio via minimp3. minimp3
// emits float PCM (MINIMP3_FLOAT_OUTPUT, set in vendor/minimp3_impl.c), so this
// just de-interleaves frame by frame. Leading ID3 / non-audio frames decode to
// zero samples with a non-zero frame_bytes — we advance past them.
inline DecodedAudio decodeMp3File(const std::string& path) {
    DecodedAudio out;

    std::ifstream f(path, std::ios::binary);
    if (!f) return out;
    std::stringstream ss;
    ss << f.rdbuf();
    const std::string bytes = ss.str();
    if (bytes.empty()) return out;
    const Mp3GaplessTrim trim = readMp3GaplessTrim(bytes);

    mp3dec_t dec;
    mp3dec_init(&dec);

    const uint8_t* buf = reinterpret_cast<const uint8_t*>(bytes.data());
    int remaining = (int)bytes.size();
    int channels = 0, sampleRate = 0;
    std::vector<float> interleaved;
    interleaved.reserve(bytes.size());  // rough upper-ish bound

    mp3d_sample_t pcm[MINIMP3_MAX_SAMPLES_PER_FRAME];
    mp3dec_frame_info_t info;
    while (remaining > 0) {
        const int samples = mp3dec_decode_frame(&dec, buf, remaining, pcm, &info);
        if (info.frame_bytes <= 0) break;  // no more decodable frames
        buf += info.frame_bytes;
        remaining -= info.frame_bytes;
        if (samples > 0 && info.channels > 0) {
            channels = info.channels;
            sampleRate = info.hz;
            interleaved.insert(interleaved.end(), pcm, pcm + (size_t)samples * info.channels);
        }
    }

    if (channels <= 0 || sampleRate <= 0 || interleaved.empty()) return out;
    const int decodedFrames = (int)(interleaved.size() / (size_t)channels);
    int firstFrame = std::min(std::max(0, trim.leading), decodedFrames);
    int lastFrame = decodedFrames - std::min(std::max(0, trim.trailing), decodedFrames - firstFrame);
    if (lastFrame <= firstFrame) { firstFrame = 0; lastFrame = decodedFrames; }
    const int frames = lastFrame - firstFrame;
    out.buffer.setSize(channels, frames);
    for (int ch = 0; ch < channels; ++ch) {
        float* dst = out.buffer.getWritePointer(ch);
        for (int i = 0; i < frames; ++i)
            dst[i] = interleaved[(size_t)(firstFrame + i) * channels + ch];
    }
    out.sampleRate = sampleRate;
    out.ok = true;
    return out;
}

// Lower-cased file extension (without the dot), for codec dispatch.
inline std::string fileExtLower(const std::string& path) {
    const auto dot = path.find_last_of('.');
    if (dot == std::string::npos) return std::string();
    std::string ext = path.substr(dot + 1);
    for (char& c : ext) c = (char)((c >= 'A' && c <= 'Z') ? c - 'A' + 'a' : c);
    return ext;
}

// Decode any supported audio file by extension. Unknown extensions return an
// un-ok DecodedAudio (the caller falls back to a stub).
// Decode a PCM .wav (16- or 24-bit integer, any channel count) into planar float. Sung vocal takes are stored
// as 16-bit WAV (docs/superpowers/specs/2026-11-24-sung-vocals-design.md). Any other WAV encoding -> un-ok.
inline DecodedAudio decodeWavFile(const std::string& path) {
    DecodedAudio out;
    std::ifstream f(path, std::ios::binary);
    if (!f) return out;
    std::stringstream ss;
    ss << f.rdbuf();
    const std::string bytes = ss.str();
    const auto* b = reinterpret_cast<const uint8_t*>(bytes.data());
    auto u16 = [&](size_t o) { return (uint32_t)b[o] | ((uint32_t)b[o + 1] << 8); };
    auto u32 = [&](size_t o) { return u16(o) | (u16(o + 2) << 16); };
    if (bytes.size() < 12 || std::memcmp(b, "RIFF", 4) != 0 || std::memcmp(b + 8, "WAVE", 4) != 0) return out;
    int channels = 0, rate = 0, bits = 0, format = 0;
    size_t off = 12;
    while (off + 8 <= bytes.size()) {
        const uint32_t size = u32(off + 4);
        if (std::memcmp(b + off, "fmt ", 4) == 0 && off + 24 <= bytes.size()) {
            format = (int)u16(off + 8);
            channels = (int)u16(off + 10);
            rate = (int)u32(off + 12);
            bits = (int)u16(off + 22);
        } else if (std::memcmp(b + off, "data", 4) == 0) {
            if (format != 1 || channels < 1 || rate <= 0 || (bits != 16 && bits != 24)) return out;
            const int bytesPer = bits / 8;
            const size_t avail = std::min<size_t>(size, bytes.size() - off - 8);
            const int frames = (int)(avail / (size_t)(bytesPer * channels));
            out.buffer.setSize(channels, frames);
            const uint8_t* d = b + off + 8;
            for (int i = 0; i < frames; ++i) {
                for (int c = 0; c < channels; ++c) {
                    const uint8_t* p = d + ((size_t)i * channels + c) * bytesPer;
                    int32_t v = bits == 16 ? (int32_t)(int16_t)(p[0] | (p[1] << 8))
                                           : (int32_t)((uint32_t)p[0] << 8 | (uint32_t)p[1] << 16 | (uint32_t)p[2] << 24) >> 8;
                    out.buffer.getWritePointer(c)[i] = (float)v / (bits == 16 ? 32768.0f : 8388608.0f);
                }
            }
            out.sampleRate = rate;
            out.ok = true;
            return out;
        }
        off += 8 + size + (size % 2);
    }
    return out;
}

inline DecodedAudio decodeAudioFile(const std::string& path) {
    const std::string ext = fileExtLower(path);
    if (ext == "mp3") return decodeMp3File(path);
    if (ext == "ogg") return decodeOggFile(path);
    if (ext == "wav" || ext == "wave") return decodeWavFile(path);
    return DecodedAudio{};
}

} // namespace casperaki
