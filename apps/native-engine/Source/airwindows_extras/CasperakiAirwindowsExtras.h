// Registration entry-point for the 10 Casperaki-bundled Airwindows plugins
// (Console8 SubIn/SubOut/BussIn/BussOut, kPlateA, kPlateD, TexturizeMS,
// StereoChorus, Huge, Air2) — none of these are in Tracktion's bundled
// AIRWINDOWSPLUGIN set, but the legacy rack chains reference all of them.
//
// Sourced from Chris Johnson's MIT-licensed Airwindows repo
// (github.com/airwindows/airwindows, plugins/LinuxVST/src/) — bit-identical
// DSP to the Windows VST2 DLLs the legacy rack XML originally pointed at,
// so the legacy state="…" chunks deserialise without translation.
//
// Call registerCasperakiAirwindowsExtras(engine) after
// engine.getPluginManager().initialiseAirWindows() and before any rack
// loads — it adds 10 built-in plugin types whose xmlTypeName is what
// FXPluginRemap.h rewrites the legacy Windows DLL refs to.

#pragma once

namespace tracktion { inline namespace engine { class Engine; } }

namespace casperaki::airwindows_extras
{

void registerCasperakiAirwindowsExtras (tracktion::engine::Engine& engine);

} // namespace casperaki::airwindows_extras
