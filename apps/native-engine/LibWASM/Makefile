# Automatically generated makefile, created by the Projucer
# Don't edit this file! Your changes will be overwritten when you re-save the Projucer project!

# build with "V=1" for verbose builds
ifeq ($(V), 1)
V_AT =
else
V_AT = @
endif

# (this disables dependency generation if multiple architectures are set)
DEPFLAGS := $(if $(word 2, $(TARGET_ARCH)), , -MMD)

ifndef STRIP
  STRIP=strip
endif

ifndef AR
  AR=ar
endif

ifndef CONFIG
  CONFIG=Debug
endif

JUCE_ARCH_LABEL := $(shell uname -m)

ifeq ($(CONFIG),Debug)
  JUCE_BINDIR := build
  JUCE_LIBDIR := build
  JUCE_OBJDIR := build/intermediate/Debug
  JUCE_OUTDIR := build

  ifeq ($(TARGET_ARCH),)
    TARGET_ARCH := # -march=native
  endif

  JUCE_CPPFLAGS := $(DEPFLAGS) "-DLINUX=1" "-DNDEBUG=1" "-DJUCE_USE_MP3AUDIOFORMAT=1" "-DJUCE_DISPLAY_SPLASH_SCREEN=0" "-DJUCE_USE_DARK_SPLASH_SCREEN=1" "-DJUCE_PROJUCER_VERSION=0x60106" "-DJUCE_MODULE_AVAILABLE_juce_audio_basics=1" "-DJUCE_MODULE_AVAILABLE_juce_audio_devices=1" "-DJUCE_MODULE_AVAILABLE_juce_audio_formats=1" "-DJUCE_MODULE_AVAILABLE_juce_audio_processors=1" "-DJUCE_MODULE_AVAILABLE_juce_audio_utils=1" "-DJUCE_MODULE_AVAILABLE_juce_core=1" "-DJUCE_MODULE_AVAILABLE_juce_data_structures=1" "-DJUCE_MODULE_AVAILABLE_juce_dsp=1" "-DJUCE_MODULE_AVAILABLE_juce_events=1" "-DJUCE_MODULE_AVAILABLE_juce_graphics=1" "-DJUCE_MODULE_AVAILABLE_juce_gui_basics=1" "-DJUCE_MODULE_AVAILABLE_juce_gui_extra=1" "-DJUCE_MODULE_AVAILABLE_juce_osc=1" "-DJUCE_MODULE_AVAILABLE_tracktion_engine=1" "-DJUCE_MODULE_AVAILABLE_tracktion_graph=1" "-DJUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1" "-DJUCE_STRICT_REFCOUNTEDPOINTER=1" "-DJUCE_STANDALONE_APPLICATION=1" "-DJUCER_LINUX_MAKE_DEA183E6=1" "-DJUCE_APP_VERSION=1.0.0" "-DJUCE_APP_VERSION_HEX=0x10000" "-DJUCE_MODAL_LOOPS_PERMITTED=1" -pthread -I./JuceLibraryCode -I../dependencies/tracktion_engine_emscripten/modules/juce/modules -I$(HOME)/JUCE/modules -I../dependencies/tracktion_engine_emscripten/modules $(CPPFLAGS)
  JUCE_CPPFLAGS_STATIC_LIBRARY :=  "-DJucePlugin_Build_VST=0" "-DJucePlugin_Build_VST3=0" "-DJucePlugin_Build_AU=0" "-DJucePlugin_Build_AUv3=0" "-DJucePlugin_Build_RTAS=0" "-DJucePlugin_Build_AAX=0" "-DJucePlugin_Build_Standalone=0" "-DJucePlugin_Build_Unity=0"
  JUCE_TARGET_STATIC_LIBRARY := libcasperaki_engine_staticlib.js

  JUCE_CFLAGS += $(JUCE_CPPFLAGS) $(TARGET_ARCH) -g -O1 -s USE_PTHREADS=1 -s USE_FREETYPE=1 -s DISABLE_EXCEPTION_CATCHING=0 $(CFLAGS)
  JUCE_CXXFLAGS += $(JUCE_CFLAGS) -std=c++17 $(CXXFLAGS)
  JUCE_LDFLAGS += $(TARGET_ARCH) -L$(JUCE_BINDIR) -L$(JUCE_LIBDIR) -fvisibility=hidden -s USE_PTHREADS=1 -s FETCH -s USE_FREETYPE=1 -s DISABLE_EXCEPTION_CATCHING=0 -s PTHREAD_POOL_SIZE=25 -s TOTAL_MEMORY="512MB" -s NO_EXIT_RUNTIME=1 -s EXPORTED_FUNCTIONS="['_main', '_juce_animationFrameCallback', '_juce_mouseCallback', '_juce_keyboardCallback', '_juce_inputCallback']" -s EXPORTED_RUNTIME_METHODS=FS,cwrap,IDBFS \
	-s ALLOW_MEMORY_GROWTH=1 -s ALLOW_TABLE_GROWTH=1 -s EXPORT_ES6=1 -s MODULARIZE=1 -s EXPORT_ES6=1 -s LLD_REPORT_UNDEFINED -lembind -lrt -ldl -lpthread -lopenal -lidbfs.js $(LDFLAGS) --no-entry2 --export-dynamic -v

# -s PROXY_TO_PTHREAD=1  -lmp3lame  -L/opt/homebrew/Cellar/lame/3.100/lib

  CLEANCMD = rm -rf $(JUCE_OUTDIR)/$(TARGET) $(JUCE_OBJDIR)
endif

ifeq ($(CONFIG),Release)
  JUCE_BINDIR := build
  JUCE_LIBDIR := build
  JUCE_OBJDIR := build/intermediate/Release
  JUCE_OUTDIR := build

  ifeq ($(TARGET_ARCH),)
    TARGET_ARCH := # -march=native
  endif

  JUCE_CPPFLAGS := $(DEPFLAGS) "-DLINUX=1" "-DNDEBUG=1" "-DJUCE_USE_MP3AUDIOFORMAT=1" "-DJUCE_DISPLAY_SPLASH_SCREEN=0" "-DJUCE_USE_DARK_SPLASH_SCREEN=1" "-DJUCE_PROJUCER_VERSION=0x60106" "-DJUCE_MODULE_AVAILABLE_juce_audio_basics=1" "-DJUCE_MODULE_AVAILABLE_juce_audio_devices=1" "-DJUCE_MODULE_AVAILABLE_juce_audio_formats=1" "-DJUCE_MODULE_AVAILABLE_juce_audio_processors=1" "-DJUCE_MODULE_AVAILABLE_juce_audio_utils=1" "-DJUCE_MODULE_AVAILABLE_juce_core=1" "-DJUCE_MODULE_AVAILABLE_juce_data_structures=1" "-DJUCE_MODULE_AVAILABLE_juce_dsp=1" "-DJUCE_MODULE_AVAILABLE_juce_events=1" "-DJUCE_MODULE_AVAILABLE_juce_graphics=1" "-DJUCE_MODULE_AVAILABLE_juce_gui_basics=1" "-DJUCE_MODULE_AVAILABLE_juce_gui_extra=1" "-DJUCE_MODULE_AVAILABLE_juce_osc=1" "-DJUCE_MODULE_AVAILABLE_tracktion_engine=1" "-DJUCE_MODULE_AVAILABLE_tracktion_graph=1" "-DJUCE_GLOBAL_MODULE_SETTINGS_INCLUDED=1" "-DJUCE_STRICT_REFCOUNTEDPOINTER=1" "-DJUCE_STANDALONE_APPLICATION=1" "-DJUCER_LINUX_MAKE_DEA183E6=1" "-DJUCE_APP_VERSION=1.0.0" "-DJUCE_APP_VERSION_HEX=0x10000" "-DJUCE_MODAL_LOOPS_PERMITTED=1" -pthread -I./JuceLibraryCode -I../dependencies/tracktion_engine_emscripten/modules/juce/modules -I$(HOME)/JUCE/modules -I../dependencies/tracktion_engine_emscripten/modules $(CPPFLAGS)
  JUCE_CPPFLAGS_STATIC_LIBRARY :=  "-DJucePlugin_Build_VST=0" "-DJucePlugin_Build_VST3=0" "-DJucePlugin_Build_AU=0" "-DJucePlugin_Build_AUv3=0" "-DJucePlugin_Build_RTAS=0" "-DJucePlugin_Build_AAX=0" "-DJucePlugin_Build_Standalone=0" "-DJucePlugin_Build_Unity=0"
  JUCE_TARGET_STATIC_LIBRARY := libcasperaki_engine_staticlib.js

  JUCE_CFLAGS += $(JUCE_CPPFLAGS) $(TARGET_ARCH) -O3 -s USE_PTHREADS=1 -s USE_FREETYPE=1 -s DISABLE_EXCEPTION_CATCHING=0 $(CFLAGS)
  JUCE_CXXFLAGS += $(JUCE_CFLAGS) -std=c++17 $(CXXFLAGS)
  JUCE_LDFLAGS += $(TARGET_ARCH) -L$(JUCE_BINDIR) -L$(JUCE_LIBDIR) -fvisibility=hidden -s USE_PTHREADS=1 -s FETCH -s USE_FREETYPE=1 -s DISABLE_EXCEPTION_CATCHING=0 -s PTHREAD_POOL_SIZE=25 -s TOTAL_MEMORY="512MB" -s NO_EXIT_RUNTIME=1 -s EXPORTED_FUNCTIONS="['_main', '_juce_animationFrameCallback', '_juce_mouseCallback', '_juce_keyboardCallback', '_juce_inputCallback']" -s EXPORTED_RUNTIME_METHODS=FS,cwrap,IDBFS \
	-s ALLOW_MEMORY_GROWTH=1 -s ALLOW_TABLE_GROWTH=1 -s EXPORT_ES6=1 -s MODULARIZE=1 -s EXPORT_ES6=1 -s LLD_REPORT_UNDEFINED -lembind -lrt -ldl -lpthread -lopenal -lidbfs.js $(LDFLAGS) --no-entry2 --export-dynamic -v

# -s PROXY_TO_PTHREAD=1 -lmp3lame 

  CLEANCMD = rm -rf $(JUCE_OUTDIR)/$(TARGET) $(JUCE_OBJDIR)
endif

# $(JUCE_OBJDIR)/SamplesDownloadTask_31e918a3.o \
	$(JUCE_OBJDIR)/wave_1c27d04b.o \
	$(JUCE_OBJDIR)/CasperakiSamplerPlugin_1d0b75de.o \
	$(JUCE_OBJDIR)/BinaryData2_13802748.o \
	$(JUCE_OBJDIR)/juce_LinuxSubprocessHelperBinaryData_e1db7dc.o \
	$(JUCE_OBJDIR)/include_tracktion_core_5e215fbf.o \

OBJECTS_STATIC_LIBRARY := \
	$(JUCE_OBJDIR)/main_ff6debee.o \
	$(JUCE_OBJDIR)/Sequencer_e57de283.o \
	$(JUCE_OBJDIR)/Instrument_ae7ebc04.o \
	$(JUCE_OBJDIR)/CasperakiEngine_9661b469.o \
	$(JUCE_OBJDIR)/SamplesDownloadTask-emscripten_400bb6d0.o \
	$(JUCE_OBJDIR)/BinaryData_4af29534.o \
	$(JUCE_OBJDIR)/BinaryData2_13802748.o \
	$(JUCE_OBJDIR)/CasperakiSamplerPlugin_1d0b75de.o \
	$(JUCE_OBJDIR)/include_juce_audio_basics_854129ea.o \
	$(JUCE_OBJDIR)/include_juce_audio_devices_c670bf62.o \
	$(JUCE_OBJDIR)/include_juce_audio_formats_7957c261.o \
	$(JUCE_OBJDIR)/include_juce_audio_processors_46d0f806.o \
	$(JUCE_OBJDIR)/include_juce_audio_utils_d9446d36.o \
	$(JUCE_OBJDIR)/include_juce_core_f75b497b.o \
	$(JUCE_OBJDIR)/include_juce_data_structures_7e723c43.o \
	$(JUCE_OBJDIR)/include_juce_dsp_e067206f.o \
	$(JUCE_OBJDIR)/include_juce_events_92002035.o \
	$(JUCE_OBJDIR)/include_juce_graphics_915442e7.o \
	$(JUCE_OBJDIR)/include_juce_gui_basics_1fa21125.o \
	$(JUCE_OBJDIR)/include_juce_gui_extra_fc3dee7a.o \
	$(JUCE_OBJDIR)/include_juce_osc_25947aad.o \
	$(JUCE_OBJDIR)/include_tracktion_engine_airwindows_d4e98c0.o \
	$(JUCE_OBJDIR)/include_tracktion_engine_audio_files_48449631.o \
	$(JUCE_OBJDIR)/include_tracktion_engine_model_1_a7e9ce7e.o \
	$(JUCE_OBJDIR)/include_tracktion_engine_model_2_a7f7e5ff.o \
	$(JUCE_OBJDIR)/include_tracktion_engine_playback_19c98862.o \
	$(JUCE_OBJDIR)/include_tracktion_engine_plugins_b0915b03.o \
	$(JUCE_OBJDIR)/include_tracktion_engine_timestretch_f57363fb.o \
	$(JUCE_OBJDIR)/include_tracktion_engine_utils_66035714.o \
	$(JUCE_OBJDIR)/include_tracktion_graph_81544578.o \

.PHONY: clean all strip

all : $(JUCE_OUTDIR)/$(JUCE_TARGET_STATIC_LIBRARY)

$(JUCE_OUTDIR)/$(JUCE_TARGET_STATIC_LIBRARY) : $(OBJECTS_STATIC_LIBRARY) $(RESOURCES)
	@command -v pkg-config >/dev/null 2>&1 || { echo >&2 "pkg-config not installed. Please, install it."; exit 1; }

	@echo Linking "casperaki_engine_staticlib - Static Library"
	-$(V_AT)mkdir -p $(JUCE_BINDIR)
	-$(V_AT)mkdir -p $(JUCE_LIBDIR)
	-$(V_AT)mkdir -p $(JUCE_OUTDIR)
	$(V_AT)$(CXX) -o $(JUCE_OUTDIR)/$(JUCE_TARGET_STATIC_LIBRARY) $(OBJECTS_STATIC_LIBRARY) $(JUCE_LDFLAGS) $(JUCE_LDFLAGS_APP) $(RESOURCES) $(TARGET_ARCH)

$(JUCE_OBJDIR)/main_ff6debee.o: main.cpp
	-$(V_AT)mkdir -p $(@D)
	@echo "Compiling main.cpp"
	$(V_AT)$(CXX) $(JUCE_CXXFLAGS) $(JUCE_CPPFLAGS_STATIC_LIBRARY) $(JUCE_CFLAGS_STATIC_LIBRARY) -o "$@" -c "$<"

$(JUCE_OBJDIR)/wave_1c27d04b.o: ../Source/instruments/mp3decode/wave/wave.cpp
	-$(V_AT)mkdir -p $(@D)
	@echo "Compiling wave.cpp"
	$(V_AT)$(CXX) $(JUCE_CXXFLAGS) $(JUCE_CPPFLAGS_STATIC_LIBRARY) $(JUCE_CFLAGS_STATIC_LIBRARY) -o "$@" -c "$<"

$(JUCE_OBJDIR)/Sequencer_e57de283.o: ../Source/sequencer/Sequencer.cpp
	-$(V_AT)mkdir -p $(@D)
	@echo "Compiling Sequencer.cpp"
	$(V_AT)$(CXX) $(JUCE_CXXFLAGS) $(JUCE_CPPFLAGS_STATIC_LIBRARY) $(JUCE_CFLAGS_STATIC_LIBRARY) -o "$@" -c "$<"

$(JUCE_OBJDIR)/Instrument_ae7ebc04.o: ../Source/instruments/Instrument.cpp
	-$(V_AT)mkdir -p $(@D)
	@echo "Compiling Instrument.cpp"
	$(V_AT)$(CXX) $(JUCE_CXXFLAGS) $(JUCE_CPPFLAGS_STATIC_LIBRARY) $(JUCE_CFLAGS_STATIC_LIBRARY) -o "$@" -c "$<"

$(JUCE_OBJDIR)/CasperakiEngine_9661b469.o: ../Source/CasperakiEngine.cpp
	-$(V_AT)mkdir -p $(@D)
	@echo "Compiling CasperakiEngine.cpp"
	$(V_AT)$(CXX) $(JUCE_CXXFLAGS) $(JUCE_CPPFLAGS_STATIC_LIBRARY) $(JUCE_CFLAGS_STATIC_LIBRARY) -o "$@" -c "$<"

$(JUCE_OBJDIR)/SamplesDownloadTask-emscripten_400bb6d0.o: ../Source/instruments/SamplesDownloadTask-emscripten.cpp
	-$(V_AT)mkdir -p $(@D)
	@echo "Compiling SamplesDownloadTask-emscripten.cpp"
	$(V_AT)$(CXX) $(JUCE_CXXFLAGS) $(JUCE_CPPFLAGS_STATIC_LIBRARY) $(JUCE_CFLAGS_STATIC_LIBRARY) -o "$@" -c "$<"

$(JUCE_OBJDIR)/BinaryData_4af29534.o: JuceLibraryCode/BinaryData.cpp
	-$(V_AT)mkdir -p $(@D)
	@echo "Compiling BinaryData.cpp"
	$(V_AT)$(CXX) $(JUCE_CXXFLAGS) $(JUCE_CPPFLAGS_STATIC_LIBRARY) $(JUCE_CFLAGS_STATIC_LIBRARY) -o "$@" -c "$<"

$(JUCE_OBJDIR)/CasperakiSamplerPlugin_1d0b75de.o: ../Source/CasperakiSamplerPlugin.cpp
	-$(V_AT)mkdir -p $(@D)
	@echo "Compiling CasperakiSamplerPlugin.cpp"
	$(V_AT)$(CXX) $(JUCE_CXXFLAGS) $(JUCE_CPPFLAGS_STATIC_LIBRARY) $(JUCE_CFLAGS_STATIC_LIBRARY) -o "$@" -c "$<"

$(JUCE_OBJDIR)/BinaryData2_13802748.o: JuceLibraryCode/BinaryData2.cpp
	-$(V_AT)mkdir -p $(@D)
	@echo "Compiling BinaryData2.cpp"
	$(V_AT)$(CXX) $(JUCE_CXXFLAGS) $(JUCE_CPPFLAGS_STATIC_LIBRARY) $(JUCE_CFLAGS_STATIC_LIBRARY) -o "$@" -c "$<"

$(JUCE_OBJDIR)/include_juce_audio_basics_854129ea.o: JuceLibraryCode/include_juce_audio_basics.cpp
	-$(V_AT)mkdir -p $(@D)
	@echo "Compiling include_juce_audio_basics.cpp"
	$(V_AT)$(CXX) $(JUCE_CXXFLAGS) $(JUCE_CPPFLAGS_STATIC_LIBRARY) $(JUCE_CFLAGS_STATIC_LIBRARY) -o "$@" -c "$<"

$(JUCE_OBJDIR)/include_juce_audio_devices_c670bf62.o: JuceLibraryCode/include_juce_audio_devices.cpp
	-$(V_AT)mkdir -p $(@D)
	@echo "Compiling include_juce_audio_devices.cpp"
	$(V_AT)$(CXX) $(JUCE_CXXFLAGS) $(JUCE_CPPFLAGS_STATIC_LIBRARY) $(JUCE_CFLAGS_STATIC_LIBRARY) -o "$@" -c "$<"

$(JUCE_OBJDIR)/include_juce_audio_formats_7957c261.o: JuceLibraryCode/include_juce_audio_formats.cpp
	-$(V_AT)mkdir -p $(@D)
	@echo "Compiling include_juce_audio_formats.cpp"
	$(V_AT)$(CXX) $(JUCE_CXXFLAGS) $(JUCE_CPPFLAGS_STATIC_LIBRARY) $(JUCE_CFLAGS_STATIC_LIBRARY) -o "$@" -c "$<"

$(JUCE_OBJDIR)/include_juce_audio_processors_46d0f806.o: JuceLibraryCode/include_juce_audio_processors.cpp
	-$(V_AT)mkdir -p $(@D)
	@echo "Compiling include_juce_audio_processors.cpp"
	$(V_AT)$(CXX) $(JUCE_CXXFLAGS) $(JUCE_CPPFLAGS_STATIC_LIBRARY) $(JUCE_CFLAGS_STATIC_LIBRARY) -o "$@" -c "$<"

$(JUCE_OBJDIR)/include_juce_audio_utils_d9446d36.o: JuceLibraryCode/include_juce_audio_utils.cpp
	-$(V_AT)mkdir -p $(@D)
	@echo "Compiling include_juce_audio_utils.cpp"
	$(V_AT)$(CXX) $(JUCE_CXXFLAGS) $(JUCE_CPPFLAGS_STATIC_LIBRARY) $(JUCE_CFLAGS_STATIC_LIBRARY) -o "$@" -c "$<"

$(JUCE_OBJDIR)/include_juce_core_f75b497b.o: JuceLibraryCode/include_juce_core.cpp
	-$(V_AT)mkdir -p $(@D)
	@echo "Compiling include_juce_core.cpp"
	$(V_AT)$(CXX) $(JUCE_CXXFLAGS) $(JUCE_CPPFLAGS_STATIC_LIBRARY) $(JUCE_CFLAGS_STATIC_LIBRARY) -o "$@" -c "$<"

$(JUCE_OBJDIR)/include_juce_data_structures_7e723c43.o: JuceLibraryCode/include_juce_data_structures.cpp
	-$(V_AT)mkdir -p $(@D)
	@echo "Compiling include_juce_data_structures.cpp"
	$(V_AT)$(CXX) $(JUCE_CXXFLAGS) $(JUCE_CPPFLAGS_STATIC_LIBRARY) $(JUCE_CFLAGS_STATIC_LIBRARY) -o "$@" -c "$<"

$(JUCE_OBJDIR)/include_juce_dsp_e067206f.o: JuceLibraryCode/include_juce_dsp.cpp
	-$(V_AT)mkdir -p $(@D)
	@echo "Compiling include_juce_dsp.cpp"
	$(V_AT)$(CXX) $(JUCE_CXXFLAGS) $(JUCE_CPPFLAGS_STATIC_LIBRARY) $(JUCE_CFLAGS_STATIC_LIBRARY) -o "$@" -c "$<"

$(JUCE_OBJDIR)/include_juce_events_92002035.o: JuceLibraryCode/include_juce_events.cpp
	-$(V_AT)mkdir -p $(@D)
	@echo "Compiling include_juce_events.cpp"
	$(V_AT)$(CXX) $(JUCE_CXXFLAGS) $(JUCE_CPPFLAGS_STATIC_LIBRARY) $(JUCE_CFLAGS_STATIC_LIBRARY) -o "$@" -c "$<"

$(JUCE_OBJDIR)/include_juce_graphics_915442e7.o: JuceLibraryCode/include_juce_graphics.cpp
	-$(V_AT)mkdir -p $(@D)
	@echo "Compiling include_juce_graphics.cpp"
	$(V_AT)$(CXX) $(JUCE_CXXFLAGS) $(JUCE_CPPFLAGS_STATIC_LIBRARY) $(JUCE_CFLAGS_STATIC_LIBRARY) -o "$@" -c "$<"

$(JUCE_OBJDIR)/include_juce_gui_basics_1fa21125.o: JuceLibraryCode/include_juce_gui_basics.cpp
	-$(V_AT)mkdir -p $(@D)
	@echo "Compiling include_juce_gui_basics.cpp"
	$(V_AT)$(CXX) $(JUCE_CXXFLAGS) $(JUCE_CPPFLAGS_STATIC_LIBRARY) $(JUCE_CFLAGS_STATIC_LIBRARY) -o "$@" -c "$<"

$(JUCE_OBJDIR)/include_juce_gui_extra_fc3dee7a.o: JuceLibraryCode/include_juce_gui_extra.cpp # pre_build/juce_LinuxSubprocessHelperBinaryData.cpp
	-$(V_AT)mkdir -p $(@D)
	@echo "Compiling include_juce_gui_extra.cpp"
	$(V_AT)$(CXX) $(JUCE_CXXFLAGS) $(JUCE_CPPFLAGS_STATIC_LIBRARY) $(JUCE_CFLAGS_STATIC_LIBRARY) -o "$@" -c "$<"

$(JUCE_OBJDIR)/include_juce_osc_25947aad.o: JuceLibraryCode/include_juce_osc.cpp
	-$(V_AT)mkdir -p $(@D)
	@echo "Compiling include_juce_osc.cpp"
	$(V_AT)$(CXX) $(JUCE_CXXFLAGS) $(JUCE_CPPFLAGS_STATIC_LIBRARY) $(JUCE_CFLAGS_STATIC_LIBRARY) -o "$@" -c "$<"

$(JUCE_OBJDIR)/include_tracktion_engine_airwindows_d4e98c0.o: JuceLibraryCode/include_tracktion_engine_airwindows.cpp
	-$(V_AT)mkdir -p $(@D)
	@echo "Compiling include_tracktion_engine_airwindows.cpp"
	$(V_AT)$(CXX) $(JUCE_CXXFLAGS) $(JUCE_CPPFLAGS_STATIC_LIBRARY) $(JUCE_CFLAGS_STATIC_LIBRARY) -o "$@" -c "$<"

$(JUCE_OBJDIR)/include_tracktion_engine_audio_files_48449631.o: JuceLibraryCode/include_tracktion_engine_audio_files.cpp
	-$(V_AT)mkdir -p $(@D)
	@echo "Compiling include_tracktion_engine_audio_files.cpp"
	$(V_AT)$(CXX) $(JUCE_CXXFLAGS) $(JUCE_CPPFLAGS_STATIC_LIBRARY) $(JUCE_CFLAGS_STATIC_LIBRARY) -o "$@" -c "$<"

$(JUCE_OBJDIR)/include_tracktion_engine_model_1_a7e9ce7e.o: JuceLibraryCode/include_tracktion_engine_model_1.cpp
	-$(V_AT)mkdir -p $(@D)
	@echo "Compiling include_tracktion_engine_model_1.cpp"
	$(V_AT)$(CXX) $(JUCE_CXXFLAGS) $(JUCE_CPPFLAGS_STATIC_LIBRARY) $(JUCE_CFLAGS_STATIC_LIBRARY) -o "$@" -c "$<"

$(JUCE_OBJDIR)/include_tracktion_engine_model_2_a7f7e5ff.o: JuceLibraryCode/include_tracktion_engine_model_2.cpp
	-$(V_AT)mkdir -p $(@D)
	@echo "Compiling include_tracktion_engine_model_2.cpp"
	$(V_AT)$(CXX) $(JUCE_CXXFLAGS) $(JUCE_CPPFLAGS_STATIC_LIBRARY) $(JUCE_CFLAGS_STATIC_LIBRARY) -o "$@" -c "$<"

$(JUCE_OBJDIR)/include_tracktion_engine_playback_19c98862.o: JuceLibraryCode/include_tracktion_engine_playback.cpp
	-$(V_AT)mkdir -p $(@D)
	@echo "Compiling include_tracktion_engine_playback.cpp"
	$(V_AT)$(CXX) $(JUCE_CXXFLAGS) $(JUCE_CPPFLAGS_STATIC_LIBRARY) $(JUCE_CFLAGS_STATIC_LIBRARY) -o "$@" -c "$<"

$(JUCE_OBJDIR)/include_tracktion_engine_plugins_b0915b03.o: JuceLibraryCode/include_tracktion_engine_plugins.cpp
	-$(V_AT)mkdir -p $(@D)
	@echo "Compiling include_tracktion_engine_plugins.cpp"
	$(V_AT)$(CXX) $(JUCE_CXXFLAGS) $(JUCE_CPPFLAGS_STATIC_LIBRARY) $(JUCE_CFLAGS_STATIC_LIBRARY) -o "$@" -c "$<"

$(JUCE_OBJDIR)/include_tracktion_engine_timestretch_f57363fb.o: JuceLibraryCode/include_tracktion_engine_timestretch.cpp
	-$(V_AT)mkdir -p $(@D)
	@echo "Compiling include_tracktion_engine_timestretch.cpp"
	$(V_AT)$(CXX) $(JUCE_CXXFLAGS) $(JUCE_CPPFLAGS_STATIC_LIBRARY) $(JUCE_CFLAGS_STATIC_LIBRARY) -o "$@" -c "$<"

$(JUCE_OBJDIR)/include_tracktion_engine_utils_66035714.o: JuceLibraryCode/include_tracktion_engine_utils.cpp
	-$(V_AT)mkdir -p $(@D)
	@echo "Compiling include_tracktion_engine_utils.cpp"
	$(V_AT)$(CXX) $(JUCE_CXXFLAGS) $(JUCE_CPPFLAGS_STATIC_LIBRARY) $(JUCE_CFLAGS_STATIC_LIBRARY) -o "$@" -c "$<"

$(JUCE_OBJDIR)/include_tracktion_graph_81544578.o: JuceLibraryCode/include_tracktion_graph.cpp
	-$(V_AT)mkdir -p $(@D)
	@echo "Compiling include_tracktion_graph.cpp"
	$(V_AT)$(CXX) $(JUCE_CXXFLAGS) $(JUCE_CPPFLAGS_STATIC_LIBRARY) $(JUCE_CFLAGS_STATIC_LIBRARY) -o "$@" -c "$<"

clean:
	@echo Cleaning casperaki_engine_staticlib
	$(V_AT)$(CLEANCMD)

strip:
	@echo Stripping casperaki_engine_staticlib
	-$(V_AT)$(STRIP) --strip-unneeded $(JUCE_OUTDIR)/$(TARGET)

-include $(OBJECTS_STATIC_LIBRARY:%.o=%.d)

# $(JUCE_OBJDIR)/SamplesDownloadTask_31e918a3.o: ../Source/instruments/SamplesDownloadTask.cpp
# 	-$(V_AT)mkdir -p $(@D)
# 	@echo "Compiling SamplesDownloadTask.cpp"
# 	$(V_AT)$(CXX) $(JUCE_CXXFLAGS) $(JUCE_CPPFLAGS_STATIC_LIBRARY) $(JUCE_CFLAGS_STATIC_LIBRARY) -o "$@" -c "$<"

# $(JUCE_OBJDIR)/include_tracktion_core_5e215fbf.o: JuceLibraryCode/include_tracktion_core.cpp
# 	-$(V_AT)mkdir -p $(@D)
# 	@echo "Compiling include_tracktion_core.cpp"
# 	$(V_AT)$(CXX) $(JUCE_CXXFLAGS) $(JUCE_CPPFLAGS_STATIC_LIBRARY) $(JUCE_CFLAGS_STATIC_LIBRARY) -o "$@" -c "$<"

# $(JUCE_OBJDIR)/juce_LinuxSubprocessHelperBinaryData_e1db7dc.o: pre_build/juce_LinuxSubprocessHelperBinaryData.cpp
# 	-$(V_AT)mkdir -p $(@D)
# 	@echo "Compiling juce_LinuxSubprocessHelperBinaryData.cpp"
# 	$(V_AT)$(CXX) $(JUCE_CXXFLAGS) $(JUCE_CPPFLAGS_STATIC_LIBRARY) $(JUCE_CFLAGS_STATIC_LIBRARY) -o "$@" -c "$<"

# $(JUCE_OBJDIR)/execinfo.cmd:
# 	-$(V_AT)mkdir -p $(@D)
# 	-@if [ -z "$(V_AT)" ]; then echo "Checking if we need to link libexecinfo"; fi
# 	$(V_AT)printf "int main() { return 0; }" | $(CXX) -x c++ -o $(@D)/execinfo.x -lexecinfo - >/dev/null 2>&1 && printf -- "-lexecinfo" > "$@" || touch "$@"

# $(JUCE_OBJDIR)/cxxfs.cmd:
# 	-$(V_AT)mkdir -p $(@D)
# 	-@if [ -z "$(V_AT)" ]; then echo "Checking if we need to link stdc++fs"; fi
# 	$(V_AT)printf "int main() { return 0; }" | $(CXX) -x c++ -o $(@D)/cxxfs.x -lstdc++fs - >/dev/null 2>&1 && printf -- "-lstdc++fs" > "$@" || touch "$@"

# $(JUCE_OBJDIR)/juce_LinuxSubprocessHelper_d0e1814f.o: make_helpers/juce_LinuxSubprocessHelper.cpp
# 	-$(V_AT)mkdir -p $(JUCE_OBJDIR)
# 	@echo "Compiling make_helpers/juce_LinuxSubprocessHelper.cpp"
# 	$(V_AT)$(CXX) $(JUCE_CXXFLAGS) -o "$(JUCE_OBJDIR)/juce_LinuxSubprocessHelper_d0e1814f.o" -c "$<" $(TARGET_ARCH)

# $(JUCE_BINDIR)/juce_linux_subprocess_helper: $(JUCE_OBJDIR)/juce_LinuxSubprocessHelper_d0e1814f.o
# 	-$(V_AT)mkdir -p $(JUCE_BINDIR)
# 	@echo "Linking $(JUCE_BINDIR)/juce_linux_subprocess_helper"
# 	$(V_AT)$(CXX) $(JUCE_CXXFLAGS) -o "$(JUCE_BINDIR)/juce_linux_subprocess_helper" "$(JUCE_OBJDIR)/juce_LinuxSubprocessHelper_d0e1814f.o" $(JUCE_LDFLAGS) $(TARGET_ARCH)

# $(JUCE_OBJDIR)/juce_SimpleBinaryBuilder_18cb8206.o: make_helpers/juce_SimpleBinaryBuilder.cpp
# 	-$(V_AT)mkdir -p $(JUCE_OBJDIR)
# 	@echo "Compiling make_helpers/juce_SimpleBinaryBuilder.cpp"
# 	$(V_AT)$(CXX) $(JUCE_CXXFLAGS) -o "$(JUCE_OBJDIR)/juce_SimpleBinaryBuilder_18cb8206.o" -c "$<" $(TARGET_ARCH)

# $(JUCE_BINDIR)/juce_simple_binary_builder: $(JUCE_OBJDIR)/juce_SimpleBinaryBuilder_18cb8206.o
# 	-$(V_AT)mkdir -p $(JUCE_BINDIR)
# 	@echo "Linking $(JUCE_BINDIR)/juce_simple_binary_builder"
# 	$(V_AT)$(CXX) $(JUCE_CXXFLAGS) -o "$(JUCE_BINDIR)/juce_simple_binary_builder" "$(JUCE_OBJDIR)/juce_SimpleBinaryBuilder_18cb8206.o" $(JUCE_LDFLAGS) $(TARGET_ARCH)

# pre_build/juce_LinuxSubprocessHelperBinaryData.cpp: $(JUCE_BINDIR)/juce_linux_subprocess_helper $(JUCE_BINDIR)/juce_simple_binary_builder
# 	$(V_AT)"$(JUCE_BINDIR)/juce_simple_binary_builder" "$(JUCE_BINDIR)/juce_linux_subprocess_helper" "pre_build" "juce_LinuxSubprocessHelperBinaryData" LinuxSubprocessHelperBinaryData
