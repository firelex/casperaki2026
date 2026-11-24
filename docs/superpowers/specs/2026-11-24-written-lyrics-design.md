# Written lyrics (DeepSeek) and "Change melody / Change lyrics"

> **Removed 2026-11-24 (owner's decision).** The brain no longer writes lyrics with the language model (no lyricist, no background task, no Change lyrics). Songs sing the lyric phrase bank's words again; words already recorded in a song's generator block still apply. Lyrics come back, simpler, with ACE-Step vocals. This document is history.

Date: 2026-11-24. Replaces the random phrase bank (two phrases per genre and section, cycled or cut to fit the
notes) as the source of a song's words.

## What the user gets

- Every generated song (Generate and hum to song) comes back at once with its melody; its lyrics are written for
  that melody by the language model (the self-hosted DeepSeek) in the background, which takes a minute or two (see
  "Background lyrics" below). Without a configured model, generating answers 503. If the model is unreachable, or
  cannot write lines that pass the checks after a few rounds, the Vocal track says so and offers Retry. There is no
  fallback. An added sung section gets words the same way (that edit waits for them).
- Right-click the Vocal track on a sung section:
  - **Change lyrics**: new words for that section type, throughout the song (every chorus gets the same new chorus).
  - **Change melody**: a new borrowed melody for that section type, throughout the song. Its chords come with it,
    so every instrument's part in those sections is regenerated, and the lyrics for it are written anew.

## Lyric lines

A section's melody is cut into lyric lines (`vocals/lyric-lines.ts`): a line ends at a rest of a beat or more, or
on a held note (two beats or more). Lines shorter than 4 notes join the next one, and lines over 16 notes are split
at their longest pause near the middle. Each note of a line is a syllable slot: strong (on a beat, or a beat long or
more) or weak.

## The model's brief and the checks

One request writes every sung section that needs words. Sections that share a melody and are choruses (or
pre-choruses) share their words; verses get new words each time, continuing a story. Per line the brief gives the
exact syllable count, the stress pattern (DA = strong, da = weak) and the rhyme letter. Lines are paired AABB (an odd
last line rhymes with the one before).

The answer (JSON) is checked line by line (`vocals/written-lyrics.ts`), using the CMU-based pronunciation
dictionary from casperaki2 (123k words, `data/lyrics/pronunciations.json.gz`):
- every word must be in the dictionary;
- the syllable count must equal the line's note count (with the slack below);
- the stress must fit: in at most one word per line may a multi-syllable word be stressed against the beat;
- lines with the same rhyme letter must rhyme: the same vowel sounds from the last stressed vowel on ("time" /
  "mind", "now" / "out"), and not the same word.

A line may be up to three syllables short (spare legato notes hold the syllable before them: a slur, `fullWord` "-",
sung by SoulX as note type 3) or up to two long (the longest notes, a beat or more, are split in two). Words singers
shorten count either way ("ev-ry", "fire" in one syllable).

Lines that fail go back to the model with the problems written out in plain English. Each repair starts afresh from
the brief, the lyrics so far and what is still wrong, and asks only for the failing lines. Then generation fails.

**Reasoning only for repairs.** Measured 2026-11-24 on 8 songs (one per style): reasoning off passed 5/8 in about
30 s (DeepSeek cannot count syllables without it); reasoning on for every call passed 4/8 (three ran into the token
limit after about 4 minutes) and wrote plainer lyrics; the first draft without reasoning and repairs with it passed
8/8, each after one repair, in 110–145 s per song. So: draft without reasoning, at most three repairs with it.

**Jobs.** Writing words takes minutes, and casperaki.com's Cloudflare tunnel ends any request not answered within
100 seconds. The routes that wait for the lyricist (generate, hum to song, track edits, add section) answer a request
sent with `Prefer: respond-async` with 202 `{ jobId }`; the web client polls `GET /api/jobs/:id` until it gets the
status and body the route would have answered (apps/brain/src/jobs.ts).

## Background lyrics (2026-11-24, owner's request)

Generating a song takes a fraction of a second; only the words take long. So `generateProject` saves the song with
its melody and starts a lyrics task (apps/brain/src/lyrics/tasks.ts):
- The project's lyrics state (`projects.lyrics_state` / `lyrics_task` / `lyrics_message`) is "writing" until the words
  are in, "failed" with the reason, or empty. It moves with the project when a save moves it, and the brain resumes
  every "writing" task when it starts, so a restart or deploy loses nothing.
- When the words are written, they are spliced into the project's song as it is then (`applyWrittenLyrics`: edits
  saved meanwhile stay), saved as a new version (the project moves to it), and sent to the owner's open pages on
  `GET /api/events` (server-sent events: `{type:'lyrics', state:'done', songId, newSongId, lyrics}` or
  `{state:'failed', message}`).
- The editor (apps/web/src/state/useLyricsEvents.ts) switches to the new version; unsaved edits are kept, with the
  words put into them (`/api/tracks/edit` op `applyLyrics`). The Vocal track shows a pill, "Lyrics being
  generated…", or "Lyrics failed" with Retry (`POST /api/songs/:id/lyrics`); Change lyrics / Change melody and the
  sing switch wait until the words are in.

## Where the words are kept

The written lines are recorded in the generator block (`generator.params.params.lyrics`: section name → lines),
and `writeVocals` attaches them instead of the phrase bank, so replaying the generator block rebuilds the same song.
A section without written lines gets the phrase bank. That is only the first pass the brain sends to the model,
never what a user sees. A recorded line that no longer fits its notes is an error.

A new melody is recorded as `generator.params.params.melodyVariants` (section type → variant number): the type's
melody is picked from its own random stream `vocals/melody/<type>#v<n>`. The shared stream still makes its usual
draw, so no other section's melody moves.

## Applying edits to the working song

As with track edits, the brain regenerates from the generator block and splices the result into the working song,
section by section, so client-side structure edits survive:
- Change lyrics: the vocal tracks (lead and backings).
- Change melody: every track in the sections of that type, and those sections' chords.
