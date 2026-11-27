# Avatar videos, part 2: a livelier lead singer, more scenes, and a storyboard

Date: 2026-11-27. Status: the owner chose these next steps ("1 + 4") and asked me to carry on alone overnight. The
calls marked **(my call)** were made without them; all can be changed. Builds on
`2026-11-27-avatars-design.md` (the avatars and the dance floor video as shipped: app 702bda0, engine c47bf5b).

## Intent

The owner loved the first dance floor videos. Next: the singing avatar should look like it is performing (it stands
rather still today), the videos need more places than the club, and the user should be able to plan the video
section by section: where it happens, who is in it and how it is filmed.

## 1. Livelier lead singer (my calls)

- While singing, the lead **dances with its legs and hips** (the move the section's energy picks, like the others)
  while its **upper body performs**: one hand held near the mouth as if holding a microphone, the other reaching
  out on the phrase, head and chest turned toward the camera. In calm sections the dance underneath is small; in
  choruses it is a full move.
- Between lines it dances freely with everyone (as now).
- Mouth: as now (follows the lead vocal's level and the line's vowels), plus a little more smile in choruses.

## 2. More scenes (my calls)

Built in code like the club (no new downloaded assets unless CC0, e.g. Poly Haven), each with its own lighting
that reacts to the music:

- **Club**: the existing dance floor.
- **Stage**: a concert stage seen from the crowd's side: a raised stage with a lighting truss, big side screens,
  spotlights following the lead, smoke, and a dark crowd silhouette in front (simple shapes, swaying with the beat).
- **Rooftop**: a city rooftop at night: skyline of lit windows, string lights, a low wall, warm and cool light; the
  skyline lights pulse gently with the music.
- **Beach**: sunset beach: sand, sea with moving waves, palm silhouettes, a bonfire whose light flickers with the
  beat, warm sky gradient.

## 3. Storyboard

The user plans the video per section of the song (Intro, Verse 1, Chorus 1, ...). For each section:

- **Scene**: Club, Stage, Rooftop or Beach.
- **Who is in it**: any of the avatars chosen for the video (at least one).
- **Camera**: Automatic (as now), Wide, On the singer, Orbit, Low angle, or Crane.

The Video tab's Avatars style shows the storyboard as one row per section with these three choices, filled with
the defaults (Club, everyone, Automatic) and a "use for every section" shortcut on each row. A video without changes
looks exactly like today's.

- Engine (`AvatarVideoInput`): an optional `storyboard: { scene, avatars: string[] (avatar ids), camera }[]`, one
  entry per section in order. Without it: every section in the club, everyone, automatic camera.
- Cuts between sections are hard cuts on the downbeat (music-video style) **(my call)**; within a section the camera
  follows the chosen move. The lead sings only in sections it is in; nobody else takes over the words.
- Brain: the avatars body gets `storyboard` (avatar ids are the user's avatar ids; must be among those chosen; one
  entry per section of the saved song), checked and passed on.

## Not in this round

Dance clips (the owner downloads Mixamo clips in the morning), lip colour, more than one singer, crowds of
generated people, transitions other than cuts.
