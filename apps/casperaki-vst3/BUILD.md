# Building the Casperaki VST3 pack

One generic JUCE plugin project (`AwProcessor.h` + `SimpleSideProcessor.h`) wrapping
the shared render DSP (`../web/wasm/engine/src/audio/airwindows`) as installable
plugins, one target per effect. The producer installs the pack ONCE; then every
per-song `edit.trkedit` resolves the Casperaki FX by uid.

Build per the producer's OS — same project, different toolchain. **The plugin must
match the producer's OS** (a Linux `.so` won't load in Windows/macOS Waveform).

## macOS (recommended — clean JUCE path)  → `build-mac.sh`
```
xcode-select --install                                   # Apple Clang + macOS SDK
brew install cmake
git clone --branch 8.0.6 https://github.com/juce-framework/JUCE ~/JUCE
JUCE_DIR=~/JUCE bash apps/casperaki-vst3/build-mac.sh     # universal arm64+x86_64, VST3+AU
```
Install: copy `build-mac/*_artefacts/Release/VST3/*.vst3` → `~/Library/Audio/Plug-Ins/VST3/`
(and `*.component` → `Components/` for AU). Gatekeeper for local use:
`codesign --force --deep -s - ~/Library/Audio/Plug-Ins/VST3/Casperaki*.vst3`.

## Windows  → MSVC (Visual Studio Build Tools)
JUCE 8 requires MSVC + the Windows SDK (it uses Direct2D). Install the VS 2022
Build Tools "Desktop development with C++" workload + CMake, then:
```
git clone --branch 8.0.6 https://github.com/juce-framework/JUCE C:\JUCE
cmake -S apps/casperaki-vst3 -B build-win -DCASPERAKI_JUCE_DIR=C:/JUCE -DCMAKE_BUILD_TYPE=Release
cmake --build build-win --config Release
```
Install: copy `build-win\*_artefacts\Release\VST3\*.vst3` → `%CommonProgramFiles%\VST3\`,
then rescan in Waveform.

**MinGW does NOT work:** JUCE 8 has `#error "MinGW is not supported"`, mis-detects
64-bit under MinGW (pointer truncation), and needs Direct2D headers MinGW lacks.
Use MSVC.

## Linux (dev/CI only — not for the producer)
```
cmake -S apps/casperaki-vst3 -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j
bash apps/casperaki-vst3/package-pack.sh        # -> dist/casperaki-vst3-pack.zip
```

## Package the installer (any OS)
`package-pack.sh <build-dir>` collects the built `.vst3` + `INSTALL.md` + `install.sh`
into `dist/casperaki-vst3-pack.zip` — what you send the producer to install once.
