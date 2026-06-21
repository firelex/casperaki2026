# casperaki_engine

## WASM build

```bash
cd Builds/Emscripten
emmake make clean
emmake make CONFIG=Release
```

### Updating `casperaki_engine_emscripten.jucer`

- Save the project in projucer;
- Revert all the changes in `Builds/Emscripten/Makefile` above 
  ```
  OBJECTS_STATIC_LIBRARY := \
  ```

## Android Build

- Open project `casperaki_engine/Builds/Android` in Android Studio;
- Make sure 'Active Build Variant' is set to `release_Release`;
- Run 'Make Project';

### Updating `casperaki_engine_android.jucer`

- Save the project in projucer;
- You're good to go!

## iOS Build

- Open project `casperaki_engine/Builds/Android/casperaki_engine_ios.xcodeproj`;
- Build project;

### Updating `casperaki_engine_ios.jucer`

- Save the project in projucer;
- Make the following changes to the Xcode project:
  - add the `CasperakiEngineInterface.h` to the public  header build phase
  - set the Public Headers Folder to `/include/casperaki_engine_ios`
  - remove the Executable Prefix (leave empty)
- (Alternative) Open `casperaki_engine/Builds/iOS/casperaki_engine_ios.xcodeproj/project.pbxproj` in a text/diff editor and revert all changes not related to build files;
