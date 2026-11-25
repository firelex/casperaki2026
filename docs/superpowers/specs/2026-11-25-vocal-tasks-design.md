# Vocal tasks: empty Vocal track, Write melody, Write lyrics in the background, a Tasks menu

Agreed with the owner on 2026-11-25. Second project (later): Sing (SoulX, or a singing model's own interpretation) and
Transcribe melody (a sung take back to notes with the hum-to-melody services).

## Why

Vocals are built step by step, by hand, on the Vocal track; nothing slow happens while a song is generated, and
nothing in the background disturbs playback or the song being edited. The words must sing naturally: a word is never
cut across a long held note (the phrase bank does it on about one held note in five), lines rhyme ABCB, and lines are
grammatical English.

## What the user sees

- A newly generated song has empty vocal tracks (Vocal, Backing vocals 1 and 2). Songs made before keep their vocals.
  A hummed song (hum to song) keeps its melody: the user sang it.
- Right-clicking the Vocal track offers, besides what it has today:
  - **Write melody** (instant, an edit like any other): the vocal tracks show the melody the generator chose for the
    song. The chords stay as they are, because the generator takes a sung section's chords from its melody.
  - **Write lyrics** (a background task, about one to three minutes): greyed out with the reason until there is a melody
    ("Write a melody first") and while the song's lyrics are being written ("Already writing").
- A **Tasks** item in the top bar shows the user's tasks across all their songs, with the count of those not finished:
  running ("writing · 1 min 10 s"), ready ("goes in when you stop"), done, or failed with why and a Retry button.
  Clicking a task opens its song. Finished and failed tasks stay listed for a day.
- A finished result never goes into a song while anything is playing. When playback stops (Stop, or the song ends),
  or straight away when nothing plays, it goes in: the editor shows an hourglass while the song is updated and the
  new version is loaded.

## How it works

### Generator (packages/arrangement)

- Generator param `vocalMelody` (inner params): `false` = the song's vocal tracks are empty (the tracks exist, no
  section has them on, no notes); absent = shown (every existing song). The generator still chooses the melody (it
  gives the chords), so hiding it changes nothing else in the song.
- `writeMelody(song)` (vocal edit): drops the param, regenerates the song from its params and splices the three vocal
  tracks into the working song (every section), the way `applyWrittenLyrics` does.
- `applyWrittenLyrics` also drops the param: words are written for the melody, so they show it.
- Checks for written lines (`checkSectionLyrics`, done in this round): syllable count, stress, a held note (two beats
  or more) carries the end of a word, rhyme ABCB in groups of four (a leftover three ABA, two AA, one free), never the
  same word as a rhyme.

### Brain (apps/brain)

- **Tasks table** `tasks`: id, owner, song id (the project's current song: moved with the project when a save moves
  it), kind (`writeLyrics` now; `sing`, `transcribe` later), state (`running` | `ready` | `done` | `failed`), the
  input (the song as it was when the task started, canonical JSON), the result (JSON), message, started / finished.
- **Runner**: one task at a time per kind (DeepSeek drops connections under parallel load; singing will share one
  graphics card). Running tasks resume when the brain starts. The brain only sends requests and waits: no heavy work on
  its own thread, so renders and playback are untouched.
- **Write lyrics** (`src/lyrics/lyricist.ts`, the removed writer brought back): one brief for the whole song (per line
  its syllable count, its notes as DA / da / HOLD, what it rhymes with), then up to five repairs of the lines that fail
  the checks. Every round a second reading flags lines that are not correct, natural English, and those are repaired
  too. The draft and the first three repairs run without reasoning, the last two with it. Lines still wrong after that:
  the task fails, saying which lines and why. No fallback.
- **Routes**: `GET /api/tasks` (the owner's tasks of the last day), `POST /api/tasks` `{ kind: 'writeLyrics', songId,
  song }` (song = the working copy: its melody may not be saved yet), `POST /api/tasks/:id/apply` (puts a ready result
  into the project's current song, saves it as a new version, answers the saved song), `POST /api/tasks/:id/retry`.
  `/api/events` announces `task` events (started, ready, done, failed), so open pages refresh.
- `POST /api/songs/generate` sets `vocalMelody: false`. `POST /api/tracks/edit` gains `{ kind: 'writeMelody' }`.

### Web (apps/web)

- Vocal track menu items as above (`TimelineView`).
- Tasks item in the top bar with its list (polls `GET /api/tasks` when a `task` event comes, and every few seconds
  while a task runs, for the running time).
- **Applying results** (one hook for the whole app): a ready task is applied when the live player is not playing. If
  the task's song is open in the editor, the editor shows the hourglass; when the brain answers, the editor switches to
  the saved version and, if the user had unsaved edits, puts the words into the working copy too (brain edit
  `applyLyrics`), as the removed lyrics task did.

## Approaches considered

1. **Results straight into the song as a new version** (the removed lyrics task). Simple, but replaces the version
   being played. Rejected: the owner wants nothing to change under playback.
2. **Results wait for an Apply click.** One more click per task. Rejected.
3. **Results wait for playback to stop, then go in with an hourglass** (chosen by the owner). Only the client knows
   whether something plays, so the client asks the brain to apply. Inserting only into sections that are not playing
   was considered and dropped: the player reloads the whole song to play a new version, so any switch mid-play
   restarts every track.

## Non-goals (this project)

Sing, Transcribe melody, cancelling a running task (comes with Sing, whose jobs are long), lyrics for single sections
(Write lyrics writes the whole song), languages other than English.

## Calls made by the builder (not discussed)

- Backing vocals start empty too and come with Write melody (they are made from the lead).
- Write lyrics writes every sung section anew, also when the song already has words.
- A ready result waits in the brain until a page of its owner applies it; if no page is open, it goes in the next time
  one is.
- The phrase-bank words stay on the melody until lyrics are written (the melody needs a syllable per note).
