# Video modes: 3D only, and a casting show

Date: 2026-11-28. Status: design; approaches and the four open questions answered by the owner (see "Owner's answers"); the owner's words are quoted, my calls are marked
**(my call)**. Builds on `2026-11-27-avatars-design.md` and `2026-11-27-avatar-scenes-storyboard-design.md` (avatars,
the 3D dance floor, scenes, storyboard, dance clips).

## Intent

The 3D avatar videos are "so good now" that the owner wants only them: "Forget the console and 2D dance we have …
you can delete the rest." The 3D video gets **modes**: "just music video", "casting", and a third the owner has not
named yet (the design leaves room for it; nothing is built for it).

Casting is a talent-show video built from what we have: the singer introduced backstage by a narrator, walking
through a stage door onto the stage, four judges who banter and question the singer, the performance, and the
verdicts. The owner's one strong rule: **"natural conversation and nothing stilted — the rest is so good now."**

## Goals

- Remove the console video and the 2D cartoon video everywhere (website, brain, video engine); the Video tab offers
  only the 3D avatar video, in modes.
- Mode **Music video**: today's avatar video, unchanged (storyboard, scenes, dance clips).
- Mode **Casting**, in this order:
  1. **Backstage.** The singer in a backstage room, seated or standing (several sets: dressing room with mirror
     lights, green room with sofa, corridor by the stage door), while a **narrator** (voice over, never seen) says who
     this is. Music under it: "Poised and Ready.mp3".
  2. **Stage door.** The singer walks through the stage door and appears on the stage side, walking to the centre.
     Music: "The Grand Entrance.mp3" (14.5 s).
  3. **Judges.** Four judges seated in chairs in front of the stage, facing it: **Ice** (snarky Englishman), **Nicky**
     (Black woman from the US), **Love** (blonde from Australia), **Bob** (Irish man). They banter a little, and one
     or more asks the singer something; the singer answers.
  4. **Performance.** The song's intro, first verse and first chorus ("intro, verse and chorus is what they should
     perform"), sung on stage, the judges watching and reacting; the song fades out after the first chorus.
  5. **Judging.** Each judge's verdict, ending "yes" or "no"; the singer reacts.
- Talk that sounds like people talking: short turns, reactions, interruptions, teasing, grounded in the actual song
  and singer.
- Each singer gets a speaking voice that fits their singing voice.

## Non-goals (this round)

- The third mode.
- Live audiences, applause tracks beyond a short stock sting, crowd shots of real people.
- Lip shapes from phonemes for speech (mouths follow the speech's loudness and vowels as singing does now).
- Editing the script by hand in the website (it can come later; the script is saved so it could be).

## Anti-goals

- **Stilted talk**: lines that announce themselves ("As an Englishman, I…"), every judge speaking in turn with equal
  length, compliments with no edge, the same jokes every video.
- **Imitating real people**: the judges are our own characters. Their names, looks and voices must not copy real TV
  judges; prompts never name a real person.
- Singers' voices used beyond their consent: speaking voices are made only for singers already in the user's library
  (whose uploader confirmed the right to use the voice).

## Constraints

- **Speech model: Breeze TTS 2** (`~/breeze-tts-2` on datigator; voices from a written description, or copied from a
  sample). Its licence is **research and non-commercial only** for the model and everything it generates. Fine for
  building and testing; before casting videos are published commercially we need another model or the makers'
  permission. (Flagged to the owner 2026-11-28.)
- **Voices copied from singing do not work**: tested on Karla and Kesha, the spoken lines sound sung.
- **One GPU** (RTX PRO 6000, shared with singing, music, training). Breeze needs about 8 GB (eager) or 14 GB (fast
  path) while loaded. The owner may later add a GPU or move work to the Spark: keep the speech service movable (its own
  URL).
- No fallbacks (owner's rule): a missing voice, a failed line, an unreachable service fails the video with a message
  naming it.
- LLM prompts in plain English, understandable without this codebase.
- Assets: the four judges are avatars from the same Character Studio packs (licence unknown, datigator only); the
  music files stay outside git in `~/casperaki-data/casting-music/`.

## Approaches (chosen by the owner, 2026-11-28: "Yes, good")

1. **Speech**: (A, chosen) a speech service on datigator that wraps Breeze like our other model services, loads when a
   casting video needs speech and unloads after a few idle minutes; (B) Breeze's own script per line (reloads each
   time, ~27 s a line); (C) the existing Breeze web page (behind the Jeff sign-in).
2. **Writing the talk**: (A, chosen) a short scene plan first, then each turn written separately by the character
   speaking, seeing the plan and everything said so far (the owner: "Each turn probably needs to be prompted
   separately"); (B) one call writing the whole scene (quick, but the four drift into one voice).
3. **Putting it together**: (A, chosen) the brain lays out the whole video as a casting timeline and mixes one
   soundtrack (music, speech, song); the engine renders it in one go, mouths and cuts on the right lines; (B) render
   each part separately and join (joins, light and continuity get hard).

## Owner's answers (2026-11-28)

1. **Who performs**: the song's singer. Casting needs a song already sung (a done Sing); the user picks the performer
   among the avatars whose singer sang it. None: the Video tab says "Sing this song with one of your avatars' singers
   first." (No re-singing.)
2. **Singers' speaking voices**: try the matching approach on Karla and Kesha first, the owner listens, then build it
   in (see "Singers' speaking voices"). This is the first step of the plan; if it fails, back to the owner.
3. **Who may make casting videos** while Breeze is non-commercial: only admins (BRAIN_ADMIN_EMAILS, the owner); the
   brain refuses others (403) and the website hides the mode.
4. **The performance**: from the song's start to the end of its **first** section named chorus (anything before it
   included: intro, verses, pre-chorus), then a 3 s fade starting at the chorus's end. A song with no chorus cannot be
   used for casting: the Video tab says why.

## Decided details

### The judges

Fixed characters, the same in every video.

| Judge | Who (for the writer) | Voice (Breeze description, seed) — owner-approved 2026-11-28 |
|---|---|---|
| Ice | English, fifties, dry, snarky, hard to impress, the last word | "A man in his fifties with a dry, posh southern English accent, sardonic and unimpressed, speaking slowly", seed 7 |
| Nicky | Black American woman, forties, warm, big energy, champions singers | "A Black American woman in her forties, warm, big laugh in her voice, expressive and energetic", seed 7 |
| Love | Australian, blonde, forties, sassy, teases Ice | "A woman in her forties with a bright Australian accent, very sassy and cheeky, confident, a knowing eye-roll in her voice, teasing with attitude", seed 7 |
| Bob | Irish man, fifties, kind, easygoing, charming | "An Irish man in his fifties with a soft Dublin accent, a light, fairly high-pitched tenor voice with a little rasp, kind, easygoing and charming", seed 21 |

Their looks: four avatar recipes from the packs, stored with the engine (not in any user's library), dressed to fit
**(my call)**: Ice dark jacket, Nicky bold colours, Love blonde hair, Bob casual. Each judge's character profile for the
writer (what they care about, how they tease, what they never say) is written once and kept with the brain's prompts.

### The narrator

A voice only **(my call)**: warm, mid-Atlantic TV announcer, described for Breeze like the judges, with a fixed seed;
chosen by the owner from a few takes before building on it.

### Speech processing

Every spoken line: Breeze → 1.1× faster without changing pitch → compressed and levelled (owner: "play them a bit
faster, though, and also compress them"; tested chain: `atempo=1.1`, compressor threshold -20 dB ratio 4, loudness
-16 LUFS).

### Singers' speaking voices (owner: test first on Karla and Kesha)

Made when a singer is added (a new last step of Add a singer), and once for every existing singer, including the
built-in ones:

1. A short description of the voice (gender, how high or low it sits, bright or husky, age) written from the singing
   (its pitch range from the existing RMVPE analysis) and the uploader's description.
2. Breeze makes about eight candidate speaking voices from it (different seeds), each saying the same test line.
3. A speaker-similarity model compares each with the singer's reference and keeps the closest. Saved with the singer:
   description, seed, a sample line.

The Singers page plays the sample; the user can write their own description instead (override). Optional later: a
spoken recording uploaded with the singer, copied directly.

### Writing the talk

A scene plan per talking part (backstage narration; judges' banter; verdicts), then turns:

- **Plan** (one call): the beats of the scene, who teases whom, what the question to the singer is, the outcome's
  shape, and a length target. Grounded in: the song's title, genre, mood, tempo, its lyrics (a few lines quoted), the
  singer's name and description, and the outcome the user chose.
- **Turns** (one call each): the speaker writes their next line in character, seeing the plan, their profile and the
  whole conversation so far. Short (mostly one or two sentences), reactions and interruptions allowed. Each turn also
  gives a **delivery** note for the voice ("dry, unimpressed", "laughing") and a **gesture** for the body (nod, lean
  back, point, laugh, shake head, hands up).
- Ice has the last word in the verdicts **(my call)**.

### The singer as a character

The singer speaks only when asked something: their answers are turns like the judges', written in character from the
singer's name and description (and the avatar's name), in the singer's speaking voice.

### Verdict

Each judge says yes or no. The user chooses the outcome when making the video **(my call, proposed)**: "Through, four
yeses", "Through, three to one", or "Not this time"; the writer is told who says yes and who says no.

### Length

Backstage about 30-40 s, stage door 14.5 s (no other stings), banter about 30 s, performance (intro to the end of the first chorus,
1-1.5 min), verdicts about 45 s: about 3 minutes in all.

### The casting timeline (brain → engine)

A new engine input for the casting mode: the song input the avatar video already takes (timing, lyrics, levels), plus
an ordered list of **segments**, each with a start and end in the video's time:

- `backstage`: set (dressing room / green room / corridor), singer pose (seated / standing), narrator lines.
- `door`: the walk through the stage door.
- `talk`: the judges' banter and the singer's answers.
- `performance`: song time range mapped into video time.
- `verdicts`.

Every spoken line: speaker (narrator, a judge, the singer), its start and end, its loudness envelope (for the mouth,
like the voice levels now), and its gesture. One mixed audio file for the whole video. The engine renders cameras
from this: the speaker in frame, sometimes a reaction shot.

### Levels and mouths

The brain measures levels on the server for casting (the music video keeps the browser measurement): each spoken
line's loudness envelope (drives that speaker's mouth only while they speak), and the song's lead vocal level over the
performance (from the vocal tracks, as the avatar video's `voice` now). The singer never "sings" in talk segments.

### Motion clips for casting

Walk, sitting idle, sitting talking, sitting clapping, sitting thumbs up, standing talking, standing (nervous) idle,
bow, celebration, disappointed reaction: Mixamo clips the owner downloads into `~/casperaki-data/casting-clips/`
(apart from the dance clips). Loops (walk, idles, talking) repeat their cycle without beat analysis; the walk is
"In Place" and the engine moves the body along the path; one-offs (bow, celebration, reactions, clap, thumbs up) play
once. Each motion the casting video uses must be there; a missing one fails the video naming it (no made-up
substitute).

### Scenes to build (engine)

- **Backstage**: three small sets, built in code like the existing scenes.
- **Stage door**: a door in the backstage set and the matching door at the side of the stage, a cut between them.
- **Judges' table**: four chairs (and a long desk) in front of the existing stage scene, facing it.
- Walking, sitting, talking and reactions from the casting clips (above).
- Every backstage set has the stage door; the set and the singer's pose (seated or standing) are picked per video
  from the song (varies between songs, the same on a re-render) **(my call)**. The narrator talks about the singer and
  the song.

### Where it lives

- **Website**: the Video tab shows the 3D video with a mode choice (Music video / Casting; Casting for admins only).
  Casting asks for the performer (avatars whose singer sang the song), the outcome, the format (wide or tall) and the
  quality (preview or full); it shows progress through the steps (writing, voices, rendering).
- **Brain**: a casting task: write → speak → mix → render. One casting video per song is kept with its script and
  speech: a re-render reuses them; changing the outcome rewrites and re-speaks only the verdicts; "Write it again"
  starts over **(my call)**.
- **Writer**: the assistant's language model (ASSISTANT_LLM_URL); unset → 503 naming it. A turn that comes back
  empty, unparseable or far over its length is asked for again, at most twice; then the video fails naming the turn
  **(my call)**.
- **Speech service**: new, on datigator, its own URL in the brain's settings (movable to another GPU or the Spark).
  It runs one job at a time and unloads Breeze after a few idle minutes (new in the service harness).

### Removing the console and 2D cartoon videos

Everything only they use goes: the engine's cartoon and console compositions, schemas and components; the brain's
video planner and their styles; the website's style choices. **First** move what the 3D video borrows from the console
into shared modules (lyric overlay, renderer log, level helpers, beat pulse zoom, load retry, and the browser
measurement of track levels with its version key, which the music video still uses). Their existing rendered videos stop
being listed and their files are deleted once at brain start (cartoon jobs: `<format>.mp4`, `status-<format>.json`;
console jobs `console-*`), never touching `avatars-*` **(my call)**.

## Left to the builder

The exact scene geometry, camera framing rules for talk, the gesture set, how the speaker-similarity model is run, the
speech service's API shape (following the existing service harness), and how the casting mode reuses the music
video's code. Tests for every behaviour change; a live end-to-end casting video before calling it done.
