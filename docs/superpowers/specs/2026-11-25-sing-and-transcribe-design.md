# Sing and Transcribe melody: the vocal arrangement sung in the background

Agreed with the owner on 2026-11-25, after a night of vocal-model experiments (summary below). This is the second
project announced in [2026-11-25-vocal-tasks-design.md](2026-11-25-vocal-tasks-design.md): Sing (a singing model's
own interpretation) and Transcribe melody (a sung take back to notes), on the task system that project built.

## Why

Casperaki songs need a real sung vocal that sits on the song's own backing: in time with its bars and in its
harmony. The owner's priorities, in their words: singing quality matters most ("YuE2 and MuLa rock it"), fidelity to
our generated melody is not required ("our melodies aren't that great"), harmonies must match ("as long as harmonies
match we're good"), and verses must share a melody, at least roughly. The song in the app must show what is actually
sung: the Vocal lane's notes and words are replaced by a transcription of the sung vocal.

Casperaki is not meant to make money, so non-commercial model licences are fine (owner, 2026-11-25).

## What the experiments showed (2026-11-24/25, apps/models/ace-vocal-tests, outputs /mnt/d/casperaki-models/vocal-model-tests)

- **YuE2-3B** (m-a-p/YuE2-3B, CC BY-NC 4.0) sings best. Given a score (ABC notation: our melody and chords) it follows
  the chorus melody closely (86% of pitch within a semitone) and verses loosely (about 45%). Over a whole song it
  drifts: it adds and drops bars and plays other chords for long stretches (only half the beats on our chord). One
  short run per section (2 bars of lead-in, then the section) keeps it on our chords: 75-100% per section.
- **ChordNet** (the chord recogniser shipped with MuLaCover, five models averaged) reads our own rendered song's chords
  94% right per beat, so it can check a take's harmony and find where each of our bars is in the take (dynamic time
  warping of the two chord sequences).
- **Verses differ when sung separately** even from the same score (20-59% alike). Lower sampling temperature made
  takes worse, not closer. What works: transcribe YuE2's first verse to one note per syllable, have **SoulX-Singer**
  (Apache-2.0) sing that melody with each verse's words, then **SoulX-Singer-SVC** (voice conversion) re-sing it in the
  voice of YuE2's take: 89-96% alike, and the owner liked the result ("many things to like").
- **SoulX parts need reverb, YuE2 parts do not** (owner, by ear).
- The owner liked SoulX singing the chorus's second and third voices, and YuE2 ad-libs in the later choruses.
- Rejected on the way: ACE-Step lego (melody not followed), ACE cover from noise, MuLaCover (drifts, starts each
  section like an intro), HeartMuLa (no melody input), LeVo 2 (no melody input), re-aligning a whole-song YuE2 take.

## What the user sees

- The Vocal track's menu gains **Sing** (a background task) next to Write melody and Write lyrics. It is greyed out
  with the reason until the song has a melody and written lyrics ("Write lyrics first": SoulX and the transcription
  need the words; the phrase bank's words are not sung), and while the song is being sung ("Already singing").
- The **Tasks** page shows a Sing task with **every step**, as granular as possible (owner: "so we can debug/see
  progress. The more granular, the better"): each step's name, state (waiting / running / done / failed), running
  time, and what it found (e.g. "verse1 take 2 of 3: chords 88%, section starts 5.6 s into the take"), with a play
  button for the audio a step made (each take, each aligned section, each converted section, the backing lines). The
  steps are listed under the task in the order they run; the running one is highlighted.
- A running Sing task can be **cancelled** (it takes minutes).
- When the task is ready, the result goes in like Write lyrics': only when nothing plays, with the hourglass. The song
  then has: the Vocal lane replaced by the transcribed sung melody with our words, Backing vocals 1 and 2 made from it,
  and the sung takes playing on the vocal tracks.
- The Vocal track menu also gains **Transcribe melody**: for a sung or hummed take the user brings (not part of Sing),
  turned into the Vocal lane's notes. Its details are left to the builder within this design (below).
- YuE2 is credited (CC BY requires attribution: "Vocals sung with YuE2, m-a-p/YuE2-3B,
  https://huggingface.co/m-a-p/YuE2-3B") on the **home page** and in the **metadata of exported files** (the MP3's tags,
  the producer export's readme). Not on the song page: the owner finds that too disruptive.
- An **Ad-libs** track joins the vocal tracks (audio only, no notes) when a song is sung.

## How Sing works

### Who sings what

For every section type (verse, preChorus, chorus, bridge), in song order:

1. The **first section of the type** is sung by **YuE2** from the song's score: its melody and chords (the Vocal lane
   as written) and its lyrics, after 2 bars of the preceding chords as a lead-in.
2. A later section of the type with **the same words** plays the same take (choruses).
3. A later section of the type with **different words** (verses) is sung by **SoulX** to the melody YuE2 sang in the
   first section (transcribed, one note per syllable), with its own words, then voice-converted to the YuE2 take's
   voice.
3a. A later section **longer** than the first of its type: the bars it shares with the first follow rules 2 and 3;
   only its **extra bars** get new notes, from a YuE2 take of those bars (lead-in: the bars before them), aligned and
   joined on (owner: "new notes/YuE phrasings only for the extension"). A **shorter** one is cut at its end.
4. After the lead is transcribed, **Backing vocals 1 and 2** are made from it by the generator's existing backing
   vocal code (`generateBackings` in packages/arrangement/src/vocals/backing.ts, the lanes it makes today: chorus and
   bridge, chord tones a step around the lead) and sung by SoulX with the lead's words, voice-converted to the chorus
   take's voice.
5. **Ad-libs**: YuE2 sings "oh / yeah"-style ad-libs in the gaps of the chorus lead (where the transcribed lead rests or
   holds a note two beats or more), on the **Ad-libs** track, in the second half of the song's choruses counted from
   the middle (choruses 4-6 of 6, 3-5 of 5; builder's call). YuE2 tends to sing all through an ad-lib take, so only the
   bars with gaps are kept. Ad-libs have no notes in any lane.

### Steps (each one a row on the Tasks page)

1. **Plan**: which sections are sung by whom (the rules above); fails with the reason if the song has no melody or no
   written lyrics.
2. Per YuE2 unit (first section of each type, the ad-libs): **YuE2 take** for each of N seeds (default 3): generate,
   separate the vocal (BS-RoFormer), read the take's chords (ChordNet), align the take's bars to ours (DTW over half
   beats), score: share of the section's half-beats on our chord.
3. **Choose** the best take per unit. A unit whose best take is below the harmony threshold (default 70%) fails the
   task, naming the unit and its scores (no fallback).
4. **Transcribe the lead**: per YuE2 unit, the sung notes (pitch from the hum service's front end) cut into one note per
   syllable by forced alignment of our words to the take (torchaudio's forced aligner), so every note carries its
   syllable and word.
5. **SoulX** per copied section (verses after the first): sing the first section's transcribed melody with this
   section's words.
6. **Voice conversion** (SoulX-SVC) of each SoulX section, with the YuE2 take of its type as the voice.
7. **Backing vocals**: generate the lines from the transcribed lead; SoulX sings each; voice conversion.
8. **Mix**: levels (below) and the per-track effects; write the takes.
9. **Ready**: the result waits for the page to apply it.

### Mix

- YuE2 takes on the Vocal track: **dry** (no reverb, delay or chorus sends).
- SoulX takes (copied verses on the Vocal track; backing vocals): **wet**: reverb send -10 dB, delay -18 dB (the
  owner's pick of the test mixes was the louder, wetter one).
- Levels: each SoulX verse matched to the YuE2 chorus's loudness; backing vocals -6 dB under the lead; ad-libs -4 dB
  under the lead (first guesses from the test mix; tuning them is left to the builder).
- This needs per-track effect sends: today mix-config.json sends are per instrument type, and every vocal clip lane
  has the same type. The Vocal track carries both kinds, so the lowering (packages/engine-adapter/src/audio-clips.ts)
  splits it into two engine lanes, YuE2 takes and SoulX takes, and the engine (WASM, used for renders and playback)
  gains per-lane sends; dry or wet follows the take's kind. The user still sees one Vocal track. These sends are not
  adjustable in Pro mode in this project, and a song's own Pro-mode sends do not touch them (builder's call). The
  native engine and the producer (DAW) export are out of scope for the split.

### Where things run

- A new model service **svc-vocals** on the serving harness (apps/models/services/_serving, adapter `vocals`), next to
  svc-hum and svc-amt, started at boot by deploy/datigator/start.sh. It loads YuE2, BS-RoFormer, ChordNet, SoulX
  (singing and voice conversion) and the transcription models on the RTX 6000 (96 GB; YuE2 about 11 GB). One Sing job
  at a time (the task runner's rule).
- The harness gains **step reporting**: a job keeps a list of steps (id, label, state, times, a short text, numbers,
  produced files) that `GET /result` returns while it runs, and a way to fetch a step's file. The adapter reports
  through a callback. The brain polls it and copies the steps into the task, which gets a `steps` column; cancelling
  the task cancels the job (the harness gains job cancel).
- The **brain** stores the takes in the takes directory (BRAIN_VOCAL_TAKES_DIR, served to the browser as today),
  attaches them to the song as AI artifacts, and on apply writes the transcribed lead and the backing lines into the
  vocal lanes. The AI artifact kinds gain `yue2-vocal` (soulx-vocal stays); the lowering turns both into clips.
- Weights and code: as in the experiments (YuE2 inference package yue2_infer 0.1.5; ChordNet checkpoints; SoulX model.pt
  and model-svc.pt; RMVPE). The experiment scripts in apps/models/ace-vocal-tests/other-models (yue2_sections.py,
  yue2_assemble.py, align_by_chords.py, chordnet.py, soulx_sing_fitted.py, soulx_svc.py, syllable_notes.py,
  build_plan2_tracks.py, render_with_vocal.py) show every step working; the service is built from them, not imported.

### When the song changes (agreed with the owner)

- **While Sing runs**: if the user changes a sung section's bars, chords, melody or words, or the tempo, the result is
  not applied: the task fails with "The song changed while it was being sung: sing again". Changes elsewhere (drums,
  mix, other tracks) do not matter. Write melody and Write lyrics are greyed out while the song is being sung.
- **After it is in**: an edit that changes a sung section (bars, chords, melody, words, tempo) drops that section's
  takes: it goes silent and shows as not sung; the other sections keep theirs. **Sing again** sings the whole song
  anew. Each take records what it was sung over (a fingerprint of its section's bars, chords, melody, words and the
  tempo), so the brain can tell which takes an edit leaves stale.

## Goals

- One click sings the whole vocal arrangement of a song with written lyrics, on the song's bars and harmony.
- Every step visible on the Tasks page, with its numbers and its audio.
- The app's Vocal lane shows what is sung.

## Non-goals (this project)

- Choosing among takes by hand, re-singing one section, editing a take.
- Lyrics written by YuE2 (we always give it our words), languages other than English.
- Keeping our generated melody note for note.
- Songs without written lyrics (the phrase bank's words).

## Anti-goals (a failure even if it works)

- A vocal that clashes with the song's chords: a take below the harmony threshold never goes in.
- Changes under playback: results go in only when nothing plays (as Write lyrics).
- Heavy work on the brain's thread: the brain only sends requests and waits.

## Approaches considered

1. **One Sing task running the whole chain in a model service, every step reported** (chosen by the owner, with the
   steps shown as granularly as possible).
2. **Separate tasks: Sing lead, Transcribe, Sing backing**, each a menu item. More control, more clicks and waits, easy
   to run out of order. Rejected.
3. **The chain inside the brain.** Rejected: heavy model work stays off the brain (renders and playback), and every
   model runs as a service already.

## Left to the builder

- The step list's exact granularity and wording on the page, within "as granular as possible".
- Seeds per unit, the harmony threshold, levels (defaults above are from one test song).
- How Transcribe melody (the standalone menu item) gets its recording (upload or record in the page) and what it does
  with a take whose words are unknown (pitch-only notes, like hum to song).
- How the forced aligner handles a syllable YuE2 skipped or added (the take still has to carry every written word: a
  missing word fails the step, naming it).
- Whether backing vocals use one voice-conversion reference or each its own.
