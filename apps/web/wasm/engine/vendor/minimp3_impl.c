// minimp3 implementation TU (docs/60 Phase 1 finish — real sample library).
// Compiled as its own C translation unit (mirrors vendor/stb_vorbis.c) so the
// public-domain decoder's implementation lives in exactly one object file and
// the rest of the engine only sees the small declarations it needs.
//
// MINIMP3_FLOAT_OUTPUT makes mp3dec_decode_frame emit float PCM directly, the
// format audio/AudioDecode.h converts into a planar AudioBuffer. minimp3 is the
// SAME decoder the legacy casperaki_engine vendored
// (Source/instruments/mp3decode/minimp3.h), so the native render decodes the
// library's .mp3 assets the way the original did.
#define MINIMP3_IMPLEMENTATION
#define MINIMP3_FLOAT_OUTPUT
#include "minimp3.h"
