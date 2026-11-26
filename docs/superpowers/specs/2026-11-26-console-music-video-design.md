# Console music video: design

Date: 2026-11-26. Status: approved by the owner.

## Intent

A second style of music video, next to the cartoon one, in which the "set" is a 3D mixing desk instead of
cartoon dancers. The song's audio plays over it. A moving camera flies over the desk, and whatever is playing
comes alive: the strips of playing tracks light up, meters bounce with each track's loudness, faders ride
the fades in the song's volume automation, a knob turns as a low-pass filter sweeps, and the arrangement
scrolls past on a big screen behind the desk with each note flashing as it plays.

Why: it's a showpiece for the song itself, made from the song's own data, to post on YouTube, TikTok, Reels
and Shorts. Because it shows how the track is built, it sells Casperaki as well as the song. It came up as the
non-gimmicky use of 3D: a view to watch, not to edit in.

## Goals

- A "Console" style in the Music Video tab, in the same formats as the cartoon: wide (1920×1080), tall
  (1080×1920), and the half-size quick previews of each.
- Everything moving on screen is driven by the song's real data at that moment: track loudness, volume
  automation, low-pass automation, notes, sections. Nothing is invented or random-looking.
- The camera follows the song's structure by fixed rules (no language model), so the same song always gives
  the same video and the video is quicker to make than the cartoon one (no planning step).
- An MP4 file at the end, the same as the cartoon video: same job queue, progress line and download.

## Non-goals

- Editing in 3D, or any clickable 3D view in the editor.
- A live 3D view in the app (possible later from the same scene code, not part of this work).
- Lyric banners, dancers or cast members from the cartoon style. Leave the scene uncluttered; titles can come
  later.

## Anti-goals (failure even if it technically works)

- Motion that isn't tied to the music: meters that bounce when a track is silent, faders that move when the
  song has no automation, a camera that cuts off the beat.
- A muddy, unreadable desk: it must be clear which strip is which track (names and track colours visible on
  the name plates).
- Video data that disagrees with the editor: if the mixer shows a fade, the video's fader must make the same
  move at the same moment.

## Constraints

- The video engine is the separate repo `firelex/casperaki-video` (local `~/apps/casperaki-video`), built on
  Remotion 4.0.545, which renders each frame with React in headless Chrome. The brain consumes it as
  `@casperaki/video` from GitHub. 3D goes in through `@remotion/three` (three.js via react-three-fiber),
  pinned to the same Remotion version. Headless Chrome must be able to render WebGL on datigator (Remotion's
  `chromiumOptions.gl`, e.g. `angle` or `swangle`); confirming this is the first task.
  **Owner's decision:** try the RTX GPU first (datigator is WSL2, so this may need setup); spend about an hour
  on it at most. If it doesn't work by then, accept the slower software rendering (`swangle`) for now and keep
  the scene light (few lights, no soft shadows). Render time is a background cost, not a blocker.
- The engine's rule stands: it never reads a Casperaki song directly. Casperaki builds the input with an
  adapter on its side.
- The owner's standing rule: no fallbacks. Missing data (no track levels, a track with no colour) is an error
  with a clear message, never a silent default.

## Approaches considered

1. **A second style inside the existing video engine, rendered by the brain (chosen).** Same pipeline as the
   cartoon: background job, progress, MP4. Each frame is drawn from data, so the video is the same every time
   and never stutters. Costs: the brain has to be given each track's loudness over time and the automation
   curves.
2. **Record a live 3D view in the browser while the song plays.** Would also give a live view in the app, but
   the recording takes as long as the song, any stutter on the owner's machine is in the video, the browser
   records WebM rather than MP4, and tall videos are awkward.

The owner picked 1.

## Where the data comes from

Track loudness and automation are not on the brain today. The editor computes them in the browser: the
meter worker (`apps/web/src/audio/livePlayer.ts`, `meters()`) renders the song silently through the WASM
engine and returns, per track, the peak level in short time bins (`LaneMeters.peaks`, `binSec`), the
return-bus and master peaks (`busPeaks`), and the mix as the engine resolved it (`ResolvedMix`): each
track's target volume, its volume automation and its low-pass cutoff automation, sampled every `step` seconds
(`SampledAutomation`). The same data drives the mixer's meters and moving faders.

**My call:** the Music Video tab gets this data from the live player for the song version on screen (running
the meter worker if it isn't cached yet, with its progress shown), together with the tracks, colours, clips
and notes the editor already has (`SequencerModel`), and sends it with the start request. The brain checks it
belongs to the saved version it is rendering (the request carries the version key, and the brain rejects a
mismatch with a clear message) and passes it through to the engine. That keeps one source of truth: what the
editor shows is what the video shows.

**The version (my call).** A version is the saved song text plus its Pro-mode mix overrides plus its vocal
takes: everything that changes the sound. There is no version key today (the live player files a saved
song's meters under the song id alone, and an unsaved edit under `edit:<hash>`), so this work adds one: a hash
of those three parts, computed the same way in the browser and on the brain. Rules:
- The tab refuses to start a console video while the editor has unsaved edits ("Save the song first"),
  the way Pro mode already does.
- The console job's audio must come from the same version. Today `videoService.exportedMix()` reuses any
  export that didn't fail and starts a new one without the Pro mix or the vocal takes (unlike the songs route,
  `songs.ts:317`). For the console style, the brain records the version key with each export, re-exports when
  the key differs, and passes the Pro mix and takes the way the songs route does. The cartoon path gets the
  same fix, since it has the same stale-audio bug. The alternative, running the WASM engine on the brain in Node to compute
the same data, avoids needing the browser but duplicates the meter pipeline; it is not part of this work.

Known difference: the video's audio is the brain's exported (mastered) mix from the native engine, while the
levels come from the WASM engine. The two engines are kept at render parity, so the movement will match the
sound; mastering only changes overall loudness, which the meters are normalised against anyway.

## The design

### Engine side (`casperaki-video`)

- A new input part, `ConsoleData`, validated with zod like the rest of `VideoInput`:
  - `tracks`: in mixer order, each with name, colour (hex), group bus name, target volume (dB),
    `levels` (peak per bin, with the shared `binSeconds`), optional `volumeAutomation` and
    `lowPassAutomation` (`{ t0, step, values }`), and `clips`: start and end seconds, the section name, and
    the notes (start, length, pitch, velocity).
  - `master` levels per bin, the same bins.
- A new composition per orientation (`ConsoleVideo`, `ConsoleVideoPortrait`) and a `renderConsoleVideo()`
  beside `renderVideo()`, taking `{ input, console, outPath, orientation, quality, onProgress, concurrency }`.
  No scene plan.
- The scene, in three.js:
  - **The desk:** one channel strip per track, with a name plate in the track's colour, a level meter, a
    fader and a low-pass knob. A strip glows in its colour while its track plays and goes dark when silent.
    Meters follow the track's levels at the frame's time, scaled against the loudest bin of the song. Faders
    sit at the target volume and move with the volume automation; knobs turn with the low-pass cutoff on a
    logarithmic scale (20 Hz to 20 kHz). Tracks without automation keep still faders and knobs.
  - **The screen:** behind the desk, the arrangement scrolls right to left with a fixed playhead: clips as
    blocks in track colours, notes inside them, each note flashing as it sounds.
  - **The master:** a master strip at the end of the desk with its meter.
  - **Which strips (my call):** the same strips as the mixer (`vocalLanes.mixerStrips`): a vocal's wet lane
    folds into its track's strip. Lanes with no sequencer track (transitions, risers, impacts) are shown, not
    dropped, because they are audible and make good moments on screen. They take one deliberate, named
    "effects" colour from the desk's palette. That is a design choice for a known kind of lane, not a stand-in
    for missing data: a track row with no colour is still an error. Where one strip holds several engine
    tracks, the video uses exactly the mixer's rule for its level, target volume and automation.
- **Input (my call):** `ConsoleData` is its own top-level input with title, artist, audio, BPM, first beat,
  beats per bar and sections. It does not depend on the cartoon's genre catalog, so every genre can get a
  console video. Shared fields and validators are reused, not copied.
- **The camera** follows fixed rules from the sections and the beat:
  - It moves on bar lines; a cut or swoop lands on a section start.
  - It opens on a wide shot of the whole desk and the screen.
  - In a chorus or drop (by section name), it pulls back to a wide shot with a slow orbit.
  - In a verse, it drifts slowly along the desk, closer in.
  - When a track first comes in, it swoops to that strip for a bar or two. A lead vocal entry always gets one.
  - It ends on a slow pull-back on the last section.
  - Tall format uses the same moves, framed for a narrow window (closer shots, the desk turned to fit).

### Casperaki side

- **Brain:** the video job gains a `style` (`cartoon` or `console`). Jobs and files are keyed by style and
  format, e.g. `console-landscape.mp4` and `console-landscape-preview.mp4`. A console job skips the planning
  step. The start route takes `style` and, for the console style, the console data and the song version key.
  The adapter turns the editor's data into the engine's `ConsoleData`. Existing cartoon routes and files keep
  working unchanged.
- **Web:** the Music Video tab gets a style choice (Cartoon or Console) above the orientation choice. For the
  console style it gathers the levels (with a "measuring the tracks" progress line if they aren't ready) and
  sends them with the start request. The artist name field applies to both styles. Status, progress and
  download work as they do now.

### Tests

- Engine: schema tests for `ConsoleData` (rejects missing colours, levels of the wrong length, automation
  that doesn't parse); unit tests for the camera rules (shots land on bar lines; a chorus gets the wide shot;
  a track's first entry gets a swoop) and for the value mapping (level to meter height, dB to fader position,
  cutoff to knob angle); a short render test of a few seconds, the way the cartoon renderer is tested.
- Brain: the route accepts and rejects console requests correctly (wrong version key, missing data); the
  service skips planning for the console style; jobs of the two styles don't collide.
- Web: the tab sends the console data for the console style and shows the measuring step.

## Left to the builder

- The desk's materials, lighting and colour palette (dark studio look, track colours as the accents).
- Exact camera timings and easing, within the rules above.
- How notes are drawn on the screen (bars, dots), and how many tracks fit before the desk needs a second row
  or a wider camera.
- The WebGL setting for headless Chrome, chosen by testing on datigator.
