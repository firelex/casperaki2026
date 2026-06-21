// 10 Casperaki-bundled Airwindows plugins. Mirrors Tracktion's
// tracktion_engine_airwindows_3.cpp pattern exactly:
//   1. Include tracktion_AirWindowsBase.h to activate the AudioEffectX →
//      AirWindowsBase shim macros.
//   2. Wrap each plugin's two .cpp files in a per-plugin namespace to keep
//      their identical-named helpers from colliding.
//   3. Declare the wrapper class with AIRWINDOWSPLUGIN(...) inside
//      tracktion::engine (the namespace the macro expects), define
//      xmlTypeName + pluginType, and the one-line ctor that hands a fresh
//      raw-plugin instance to AirWindowsPlugin.
//   4. Expose registerCasperakiAirwindowsExtras() so CasperakiEngine can
//      hand them to PluginManager::registerBuiltInType.

#include "CasperakiAirwindowsExtras.h"

#include <atomic>
#include <numeric>
#include <set>
#include <string>
#include <math.h>

#include <tracktion_engine/tracktion_engine.h>
#include <tracktion_engine/plugins/airwindows/tracktion_AirWindowsBase.h>

// Same diagnostic-silence wrapping Tracktion uses for its own bundled set
// (tracktion_engine_airwindows_3.cpp). The Airwindows source is loose with
// casts / sign / unused params — we adopt the same suppression so a -Werror
// build doesn't trip on them.
#if defined(__clang__)
 #pragma clang diagnostic push
 #pragma clang diagnostic ignored "-Wnon-virtual-dtor"
 #pragma clang diagnostic ignored "-Wreorder"
 #pragma clang diagnostic ignored "-Wunsequenced"
 #pragma clang diagnostic ignored "-Wint-to-pointer-cast"
 #pragma clang diagnostic ignored "-Wunused-parameter"
 #pragma clang diagnostic ignored "-Wconversion"
 #pragma clang diagnostic ignored "-Woverloaded-virtual"
 #pragma clang diagnostic ignored "-Wshadow"
 #pragma clang diagnostic ignored "-Wdeprecated-register"
 #pragma clang diagnostic ignored "-Wunused-function"
 #pragma clang diagnostic ignored "-Wsign-conversion"
 #pragma clang diagnostic ignored "-Wsign-compare"
 #pragma clang diagnostic ignored "-Wdelete-non-virtual-dtor"
 #pragma clang diagnostic ignored "-Wdeprecated-declarations"
 #pragma clang diagnostic ignored "-Wextra-semi"
 #pragma clang diagnostic ignored "-Wunused-value"
 #pragma clang diagnostic ignored "-Wunused-private-field"
 #pragma clang diagnostic ignored "-Wuninitialized"
 #pragma clang diagnostic ignored "-Widiomatic-parentheses"
 #pragma clang diagnostic ignored "-Wconditional-uninitialized"
 #pragma clang diagnostic ignored "-Wparentheses"
#elif defined(__GNUC__)
 #pragma GCC diagnostic push
 #pragma GCC diagnostic ignored "-Wnon-virtual-dtor"
 #pragma GCC diagnostic ignored "-Wreorder"
 #pragma GCC diagnostic ignored "-Wint-to-pointer-cast"
 #pragma GCC diagnostic ignored "-Wunused-parameter"
 #pragma GCC diagnostic ignored "-Wconversion"
 #pragma GCC diagnostic ignored "-Woverloaded-virtual"
 #pragma GCC diagnostic ignored "-Wshadow"
 #pragma GCC diagnostic ignored "-Wunused-function"
 #pragma GCC diagnostic ignored "-Wsign-conversion"
 #pragma GCC diagnostic ignored "-Wsign-compare"
 #pragma GCC diagnostic ignored "-Wdelete-non-virtual-dtor"
 #pragma GCC diagnostic ignored "-Wdeprecated-declarations"
 #pragma GCC diagnostic ignored "-Wextra-semi"
 #pragma GCC diagnostic ignored "-Wunused-value"
 #pragma GCC diagnostic ignored "-Wuninitialized"
 #pragma GCC diagnostic ignored "-Wparentheses"
#endif

namespace tracktion { inline namespace engine
{
namespace casperaki_extras_airwindows
{

namespace console8_sub_in     { class Console8SubIn;     }
namespace console8_sub_out    { class Console8SubOut;    }
namespace console8_buss_in    { class Console8BussIn;    }
namespace console8_buss_out   { class Console8BussOut;   }
namespace kplate_a            { class kPlateA;           }
namespace kplate_d            { class kPlateD;           }
namespace texturizems         { class TexturizeMS;       }
namespace stereochorus        { class StereoChorus;      }
namespace huge                { class Huge;              }
namespace air2                { class Air2;              }

namespace console8_sub_in {
 #include "Console8SubIn/Console8SubIn.cpp"
 #include "Console8SubIn/Console8SubInProc.cpp"
}
namespace console8_sub_out {
 #include "Console8SubOut/Console8SubOut.cpp"
 #include "Console8SubOut/Console8SubOutProc.cpp"
}
namespace console8_buss_in {
 #include "Console8BussIn/Console8BussIn.cpp"
 #include "Console8BussIn/Console8BussInProc.cpp"
}
namespace console8_buss_out {
 #include "Console8BussOut/Console8BussOut.cpp"
 #include "Console8BussOut/Console8BussOutProc.cpp"
}
namespace kplate_a {
 #include "kPlateA/kPlateA.cpp"
 #include "kPlateA/kPlateAProc.cpp"
}
namespace kplate_d {
 #include "kPlateD/kPlateD.cpp"
 #include "kPlateD/kPlateDProc.cpp"
}
namespace texturizems {
 #include "TexturizeMS/TexturizeMS.cpp"
 #include "TexturizeMS/TexturizeMSProc.cpp"
}
namespace stereochorus {
 #include "StereoChorus/StereoChorus.cpp"
 #include "StereoChorus/StereoChorusProc.cpp"
}
namespace huge {
 #include "Huge/Huge.cpp"
 #include "Huge/HugeProc.cpp"
}
namespace air2 {
 #include "Air2/Air2.cpp"
 #include "Air2/Air2Proc.cpp"
}

} // namespace casperaki_extras_airwindows

// Wrapper class declarations — sit in tracktion::engine because the
// AIRWINDOWSPLUGIN macro expands to a class definition referencing
// AirWindowsPlugin and Type unqualified. xmlTypeName values are picked to
// match what FXPluginRemap.h rewrites the legacy Windows DLL refs to.
AIRWINDOWSPLUGIN (AirWindowsConsole8SubIn,    "Console8 Sub In")
AIRWINDOWSPLUGIN (AirWindowsConsole8SubOut,   "Console8 Sub Out")
AIRWINDOWSPLUGIN (AirWindowsConsole8BussIn,   "Console8 Buss In")
AIRWINDOWSPLUGIN (AirWindowsConsole8BussOut,  "Console8 Buss Out")
AIRWINDOWSPLUGIN (AirWindowsKPlateA,          "kPlateA")
AIRWINDOWSPLUGIN (AirWindowsKPlateD,          "kPlateD")
AIRWINDOWSPLUGIN (AirWindowsTexturizeMS,      "Texturize MS")
AIRWINDOWSPLUGIN (AirWindowsStereoChorus,     "Stereo Chorus")
AIRWINDOWSPLUGIN (AirWindowsHuge,             "Huge")
AIRWINDOWSPLUGIN (AirWindowsAir2,             "Air 2")

// Static identity. xmlTypeName MUST match the rewriting target in
// FXPluginRemap.h::legacyToTracktionInternal().
const char* AirWindowsConsole8SubIn::xmlTypeName    = "airwindows_console8_sub_in";
const char* AirWindowsConsole8SubOut::xmlTypeName   = "airwindows_console8_sub_out";
const char* AirWindowsConsole8BussIn::xmlTypeName   = "airwindows_console8_buss_in";
const char* AirWindowsConsole8BussOut::xmlTypeName  = "airwindows_console8_buss_out";
const char* AirWindowsKPlateA::xmlTypeName          = "airwindows_kplate_a";
const char* AirWindowsKPlateD::xmlTypeName          = "airwindows_kplate_d";
const char* AirWindowsTexturizeMS::xmlTypeName      = "airwindows_texturizems";
const char* AirWindowsStereoChorus::xmlTypeName     = "airwindows_stereochorus";
const char* AirWindowsHuge::xmlTypeName             = "airwindows_huge";
const char* AirWindowsAir2::xmlTypeName             = "airwindows_air2";

// pluginType affects only the UI category grouping (not DSP). Guesses based
// on each plugin's role in a typical mix bus.
AirWindowsConsole8SubIn::Type    AirWindowsConsole8SubIn::pluginType    = AirWindowsPlugin::utility;
AirWindowsConsole8SubOut::Type   AirWindowsConsole8SubOut::pluginType   = AirWindowsPlugin::utility;
AirWindowsConsole8BussIn::Type   AirWindowsConsole8BussIn::pluginType   = AirWindowsPlugin::utility;
AirWindowsConsole8BussOut::Type  AirWindowsConsole8BussOut::pluginType  = AirWindowsPlugin::utility;
AirWindowsKPlateA::Type          AirWindowsKPlateA::pluginType          = AirWindowsPlugin::reverb;
AirWindowsKPlateD::Type          AirWindowsKPlateD::pluginType          = AirWindowsPlugin::reverb;
AirWindowsTexturizeMS::Type      AirWindowsTexturizeMS::pluginType      = AirWindowsPlugin::utility;
AirWindowsStereoChorus::Type     AirWindowsStereoChorus::pluginType     = AirWindowsPlugin::modulation;
AirWindowsHuge::Type             AirWindowsHuge::pluginType             = AirWindowsPlugin::distortion;
AirWindowsAir2::Type             AirWindowsAir2::pluginType             = AirWindowsPlugin::eq;

// Ctors mirror Tracktion's tracktion_AirWindows3.cpp pattern verbatim —
// hand a fresh raw-plugin into AirWindowsPlugin which owns it as
// std::unique_ptr<AirWindowsBase>.
AirWindowsConsole8SubIn::AirWindowsConsole8SubIn (PluginCreationInfo info)
    : AirWindowsPlugin (info, std::make_unique<casperaki_extras_airwindows::console8_sub_in::Console8SubIn> (&callback)) {}

AirWindowsConsole8SubOut::AirWindowsConsole8SubOut (PluginCreationInfo info)
    : AirWindowsPlugin (info, std::make_unique<casperaki_extras_airwindows::console8_sub_out::Console8SubOut> (&callback)) {}

AirWindowsConsole8BussIn::AirWindowsConsole8BussIn (PluginCreationInfo info)
    : AirWindowsPlugin (info, std::make_unique<casperaki_extras_airwindows::console8_buss_in::Console8BussIn> (&callback)) {}

AirWindowsConsole8BussOut::AirWindowsConsole8BussOut (PluginCreationInfo info)
    : AirWindowsPlugin (info, std::make_unique<casperaki_extras_airwindows::console8_buss_out::Console8BussOut> (&callback)) {}

AirWindowsKPlateA::AirWindowsKPlateA (PluginCreationInfo info)
    : AirWindowsPlugin (info, std::make_unique<casperaki_extras_airwindows::kplate_a::kPlateA> (&callback)) {}

AirWindowsKPlateD::AirWindowsKPlateD (PluginCreationInfo info)
    : AirWindowsPlugin (info, std::make_unique<casperaki_extras_airwindows::kplate_d::kPlateD> (&callback)) {}

AirWindowsTexturizeMS::AirWindowsTexturizeMS (PluginCreationInfo info)
    : AirWindowsPlugin (info, std::make_unique<casperaki_extras_airwindows::texturizems::TexturizeMS> (&callback)) {}

AirWindowsStereoChorus::AirWindowsStereoChorus (PluginCreationInfo info)
    : AirWindowsPlugin (info, std::make_unique<casperaki_extras_airwindows::stereochorus::StereoChorus> (&callback)) {}

AirWindowsHuge::AirWindowsHuge (PluginCreationInfo info)
    : AirWindowsPlugin (info, std::make_unique<casperaki_extras_airwindows::huge::Huge> (&callback)) {}

AirWindowsAir2::AirWindowsAir2 (PluginCreationInfo info)
    : AirWindowsPlugin (info, std::make_unique<casperaki_extras_airwindows::air2::Air2> (&callback)) {}

}} // namespace tracktion { inline namespace engine

#if defined(__clang__)
 #pragma clang diagnostic pop
#elif defined(__GNUC__)
 #pragma GCC diagnostic pop
#endif

namespace casperaki::airwindows_extras
{

void registerCasperakiAirwindowsExtras (tracktion::engine::Engine& engine)
{
    using namespace tracktion::engine;
    auto& pm = engine.getPluginManager();

    pm.createBuiltInType<AirWindowsConsole8SubIn>();
    pm.createBuiltInType<AirWindowsConsole8SubOut>();
    pm.createBuiltInType<AirWindowsConsole8BussIn>();
    pm.createBuiltInType<AirWindowsConsole8BussOut>();
    pm.createBuiltInType<AirWindowsKPlateA>();
    pm.createBuiltInType<AirWindowsKPlateD>();
    pm.createBuiltInType<AirWindowsTexturizeMS>();
    pm.createBuiltInType<AirWindowsStereoChorus>();
    pm.createBuiltInType<AirWindowsHuge>();
    pm.createBuiltInType<AirWindowsAir2>();
}

} // namespace casperaki::airwindows_extras
