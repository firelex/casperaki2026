# Console music video, part 2: lyrics, logo, a full desk, a studio, new camera moves

Date: 2026-11-26. Status: approved by the owner in conversation (points 1–6 below, CC0-only assets).
Builds on `2026-11-26-console-music-video-design.md` (the console style as shipped: engine `casperaki-video`
3a3b0cc, app de72ad0).

## Intent

The first console videos work and the owner likes the camera. Part 2 makes the video feel like a real studio
session and gives it the song's words and the brand: lyrics on screen, a pulsing Casperaki logo, a fuller mixing
desk, a monitor around the arrangement screen, a control room with speakers that pump with the music, and two more
camera moves (an orbit around the desk and a pulsing zoom on the beat).

## What the owner approved

1. **Lyrics.** Sung lines in a band across the lower third, drawn as a flat overlay over the 3D (always readable):
   the current line bright, the next one dimmed above it, lines fading in and out. The brain adds the timed lines
   the cartoon already gets (`lyricLines(song)`). A song without words shows none. Tall format: the band sits above
   the area TikTok/Reels cover (the cartoon's `LAYOUTS.portrait` safe areas).
2. **Monitor.** The arrangement screen gets a dark bezel with a thin lit edge, a slight bevel and a stand: a big
   studio monitor behind the desk.
3. **Fuller desk.** A chassis: sloped front armrest, wooden side cheeks, a raised meter bridge carrying the level
   meters. Per strip: three send knobs at the track's real reverb, delay and chorus sends (already in the measured
   mix data: `ResolvedMixLane.sendsDb`), mute and solo buttons, a pan knob, an EQ knob row. These stay still; only
   fader, meter and low-pass knob move (as now).
4. **Logo.** The Casperaki logo (`apps/web/public/brand/casperaki-logo.svg`) top left, small, white, pulsing with
   the master level (a brief glow and scale on loud hits, resting otherwise). Tall format: below the top area the
   apps cover.
5. **Studio room.** Walls with acoustic panels, a wooden floor, warm ceiling lights, a window into a dim live room
   behind the monitor. Two main speakers on stands beside the monitor and two small monitors on the meter bridge,
   built in code so their cones move: woofers push with the low end (the drum and bass strips' levels), tweeters
   with the master. Downloaded assets only for realism: a studio lighting environment (HDRI) for reflections, and
   wood/fabric textures. **CC0 only** (Poly Haven): no credit, commercial use allowed.
6. **Camera.** Two new moves on top of the existing rules:
   - **Orbit:** the camera circles the desk over 8 bars, once per song: in the bridge, else the last chorus.
   - **Pulse zoom:** in choruses and drops, a small punch-in on every beat, harder on loud hits (kick and master
     level), settling back; verses stay smooth.

## Constraints (unchanged from part 1)

- No fallbacks: missing data throws with a clear message. A song with no lyrics is a defined case (empty list).
- Everything on screen is a pure function of the frame and the song's data.
- GPU rendering (angle-egl + `GALLIUM_DRIVER`/`LD_LIBRARY_PATH`); the scene may be richer since the GPU works, but
  render time must stay reasonable: measure after each step (part 1: 2-min preview ≈ 85 s render).
- The engine never reads a Casperaki song; the brain adapts it.

## Approaches

- **Speakers and room in code vs. downloaded models.** Chosen: in code (the cones must move with the music; a
  downloaded model would need rigging), with CC0 HDRI and textures for realism. Downloaded models were considered
  and dropped: few CC0 studio models exist, and they would not animate.
- **Lyrics as 3D text vs. a 2D overlay.** Chosen: 2D overlay (always readable through camera moves; reuses the
  cartoon's text styling and safe areas).
- **Assets bundled in the engine repo vs. fetched at render.** Chosen: bundled (`casperaki-video/assets/`, staged
  into the render's public folder with the song), so renders never depend on the network.

## Left to the builder

Materials, colours and lighting levels; knob and button sizes; the lyric band's typography (from the cartoon's
fonts); exact orbit speed and pulse depth within the rules above; which Poly Haven assets (studio HDRI, floor and
cheek wood, panel fabric), at 1k resolution.
