/*
 * A tiny C wrapper over LAME 3.100 (libmp3lame, LGPL-2.0-or-later) for the
 * browser: stereo float PCM in, MP3 bytes out, VBR like `lame -V<q>`.
 *
 * This file is ours; LAME itself is compiled from its official source tarball
 * by build-lame-wasm.sh into public/wasm/lame.wasm, a module loaded on its own
 * (never linked into the engine), so it can be replaced by any build of LAME
 * that exports these functions (LGPL section 6).
 *
 * Use (one encoder at a time):
 *   mp3_init(sampleRate, vbrQuality)    -> 1, or 0 on error
 *   mp3_input_left() / mp3_input_right() -> float[mp3_input_frames()] to fill
 *   mp3_encode(frames)                  -> bytes written to mp3_output(), or < 0
 *   mp3_flush()                         -> the last bytes in mp3_output(), or < 0
 *   mp3_tag()                           -> the final Xing/LAME tag frame in
 *                                          mp3_output(); it replaces the first
 *                                          frame of the stream (same size)
 *   mp3_close()
 */
#include <lame.h>
#include <stdlib.h>

#define INPUT_FRAMES 8192
/* lame.h: worst case mp3buf_size = 1.25 * num_samples + 7200. */
#define OUTPUT_BYTES (INPUT_FRAMES * 5 / 4 + 7200)

static lame_global_flags* g_lame = 0;
static float g_left[INPUT_FRAMES];
static float g_right[INPUT_FRAMES];
static unsigned char g_out[OUTPUT_BYTES];

int mp3_input_frames(void) { return INPUT_FRAMES; }
float* mp3_input_left(void) { return g_left; }
float* mp3_input_right(void) { return g_right; }
unsigned char* mp3_output(void) { return g_out; }

void mp3_close(void) {
    if (g_lame) lame_close(g_lame);
    g_lame = 0;
}

int mp3_init(int sampleRate, int vbrQuality) {
    mp3_close();
    g_lame = lame_init();
    if (!g_lame) return 0;
    lame_set_in_samplerate(g_lame, sampleRate);
    lame_set_out_samplerate(g_lame, sampleRate);
    lame_set_num_channels(g_lame, 2);
    lame_set_mode(g_lame, JOINT_STEREO);
    lame_set_VBR(g_lame, vbr_default);       /* -V uses the default VBR mode (mtrh) */
    lame_set_VBR_quality(g_lame, (float)vbrQuality);
    lame_set_bWriteVbrTag(g_lame, 1);        /* Xing/LAME tag, as the lame CLI and ffmpeg write */
    lame_set_write_id3tag_automatic(g_lame, 0);
    if (lame_init_params(g_lame) < 0) {
        mp3_close();
        return 0;
    }
    return 1;
}

int mp3_encode(int frames) {
    if (!g_lame || frames < 0 || frames > INPUT_FRAMES) return -100;
    return lame_encode_buffer_ieee_float(g_lame, g_left, g_right, frames, g_out, OUTPUT_BYTES);
}

int mp3_flush(void) {
    if (!g_lame) return -100;
    return lame_encode_flush(g_lame, g_out, OUTPUT_BYTES);
}

int mp3_tag(void) {
    if (!g_lame) return -100;
    const size_t n = lame_get_lametag_frame(g_lame, g_out, OUTPUT_BYTES);
    return n > OUTPUT_BYTES ? -101 : (int)n;
}
