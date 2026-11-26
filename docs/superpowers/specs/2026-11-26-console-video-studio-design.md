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

7. **Studio door intro** (owner's idea, added later, approved "before the music"): the video opens on a studio
   door with the song's title and artist on it; the door swings open and the camera glides through into the room,
   arriving at the opening shot as the song starts. About 4 s of silence before the music; the video is that much
   longer than the song. (My call: silence rather than a room-tone sample, so there is no extra asset.)

8. **Street intro** (owner, approved): the video opens across a night street from a building, "Casperaki Studio",
   with a neon sign; the camera glides to its glass entrance (the doors slide open), down a short dim corridor to
   the studio door with the song's title (point 7), and on into the control room. **The music starts on the first
   frame** (replaces point 7's silent 4 s): the video is the song's length; the intro is about 9–10 s and ends on a
   bar line, where the studio's opening shot begins. Street backdrop: a CC0 Poly Haven night-street panorama; the
   façade, sign, doors and corridor are built in code. Lyrics show over the intro when the singing starts there.
   Rendered live per video (the owner offered pre-recording; not needed while the GPU draws it in ~15 s).

9. **Round 3 (owner, approved):**
   - The studio door swings open exactly when the song's Intro section ends; the camera is in the control room
     about a bar later (on a bar line). No section named Intro, or one under 5 s or over 30 s: the ~9 s rule.
   - Neon sign font: **Monoton** (Google Fonts, OFL).
   - Pulse zoom: subtler, and only in choruses (not drops or hooks). The logo never pulses.
   - A realistic studio: one large pro console (SSL/Neve style): dark grey, sloped toward the operator, dense knob
     rows, analog VU meters on the meter bridge whose needles swing with each track, a centre section with the
     master; track colours only on the name labels, fader caps and meter LEDs. An office chair in front of it, a
     couch (CC0 Poly Haven model) at the back of the room.

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
