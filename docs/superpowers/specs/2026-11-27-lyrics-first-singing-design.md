# Lyrics first: words shape the rhythm, the melody is laid on separately

Date: 2026-11-27. Owner's idea (27/11/2026, 07:30): write the lyrics first so they stop being bland and sound
natural; take a random existing rhythmic pattern; keep what already works with the words and change what must change
so they fit perfectly; then drape that over a melodic curve.

## Why

Today the melody comes first (a borrowed or draped pattern) and the language model writes words to its notes, syllable
by syllable (apps/brain/src/lyrics/lyricist.ts). Fitting words to fixed notes is what makes them bland: the model
spends its effort on counts and stresses, not on saying something. Freed from the notes, the model writes natural
lines in about 1.5 s per song (test of 2026-11-27, below). The rhythm then bends to the words, the way a songwriter
adjusts a groove to a lyric.

## Goals

- Lyrics that read like contemporary chart pop (the owner's references: Katy Perry, Kesha, Olivia Rodrigo, Ed
  Sheeran): plain conversational words, short punchy lines, a chorus hook built on the title, attitude, one or two
  specific details. Not poetic, not literary.
- Variety between songs: no two songs telling the same story (the test's "Met you at the corner store" problem).
- A natural rhythmic flow from the real patterns in our banks, adjusted only as far as the words need.
- Every syllable sung right: stressed syllables on strong notes (the old rules, stress.ts, no clash allowed) and each
  syllable on a note of a length it can carry (the length rule, below).
- Rhythm and melody are independent: the words shape only the rhythm; the pitches (and the chords that belong to
  them) come from a different pattern. The user can ask for a new rhythm or a new melody separately.
- Song titles in chart-pop style ("Bad Idea", "Kiss Me Back"), since the chorus hook is built on the title.

## Non-goals

- No real song lyrics are downloaded or shown to the model (copyright: a model shown a lyric echoes its lines).
- The model never fits syllables to notes any more; code does the fitting.
- Sing, the singers, ACE and transcription are unchanged: they sing whatever notes and words the lead vocal has.

## Anti-goals (failures even if it technically works)

- Lines copied from a real artist (the artist is a style cue only).
- The same premise or opening line in song after song.
- A rhythm recut so hard it no longer sounds like the pattern it came from (mechanical, one note per syllable on a
  grid).
- Silent fallbacks: the recut never gives up on a line or quietly substitutes anything; a line the lyric checks
  reject goes back to the model with the reason, as today.

## The flow

### 1. Lyrics (brain, the lyricist)

One model call per song, no reasoning, all sung section types at once (as today: sections of the same type share
their words where they share their melody). The prompt (plain English, as every prompt must be) is the pop brief of
the test (apps/brain/scripts/try-lyrics-first.ts, round 2) plus two random draws per song:

- **an artist style**: "write it the way <artist> writes: their attitude, their kind of hook and their everyday
  wording; write completely new lines, reuse none of their lyrics". A list of about a dozen current pop artists.
- **a situation**: what the song is about, from a list of about 200 pop-song premises ("a text you should not send
  at 2 a.m.", "not being invited and not caring"). The list is written once by the model, read and pruned by the
  owner, and kept in the repo as data. In the test, only the situation broke the sameness (4 of 6 songs opened
  differently; without it 11 of 12 met "at the corner store").

The section's line count and a syllable range per line come from the section's length (bars) and the tempo, so the
words fit the time; the exact range is the builder's to tune (the test used 5–9 syllables for 4-bar lines).

Checked in code (each failure goes back to the model, with what was wrong, as the repair loop does today):

- dictionary words (the pronunciation dictionary), syllable count in range;
- rhyme ABCB in groups of four (line 4 with line 2; 3 lines ABA, 2 lines AA, 1 free); near rhymes as rhyme.ts allows;
- **repeated rhyme words (owner's rule 2026-11-27)**: a rhyme word may appear twice only when it is the song's title
  (or ends the title phrase) or when the whole line is repeated; otherwise never twice in the song;
- **opening line**: rejected when it closely matches the first line of one of the owner's 50 most recent songs (word
  overlap; the threshold is the builder's).

### 2. A random rhythm pattern

Per sung section type, one rhythm drawn **uniformly at random** from every pattern eligible for the section type and
tempo (the genre's rhythmic bank, hooks flagged for remix, curated banks: the sources the recipes already draw
rhythms from). Not the pattern that fits the words best: the point is to use the whole database.

### 3. Recut: the rhythm bent to the words

Code, deterministic given the words, the pattern and the song's random stream. Per lyric line, the pattern's notes for
that line's bars are adjusted until every syllable has a note it may be sung on, changing as little as possible:

- **moves**: split a note in two; merge two neighbouring notes; move an onset by a small step to a stronger or weaker
  position; add a pickup note before the bar; drop a note; shorten or lengthen a note into a neighbouring gap.
- **goal**: every syllable on a note whose grade (stress.ts: '+', '-', '0') accepts it and whose length it can carry;
  each line ends on a word end; notes held half a bar or more carry a word's end (owner's rule 2026-11-25).
- **cost**: the fewest and smallest changes (a moved onset costs less than an added note; changes on strong beats
  cost more), so the pattern's flow survives.
- **the recut always succeeds (owner, 2026-11-27: "we can always make it so")**: there is no change budget and no
  rejection. Any pattern can be bent to any line whose syllables fit the bars (the lyric checks keep the syllable
  count in range): the cost only picks the best of the ways to do it. A recut that finds no way is a bug: an error
  naming the line, never a substitute.

**The length rule** (owner and Claude, 2026-11-27; thresholds in milliseconds, so it holds at any tempo; the numbers
are a first guess to tune by ear):

- a syllable that does not end its word gets a **short** note (under about 300 ms), even when stressed: "go" in
  gotta, "fee" in feeling, "ev" in every;
- a word's last syllable may take **any length** when its vowel can be sung long: the long vowels and diphthongs (ee,
  ay, eye, oh, oo, ow, oy, ah, aw, er), or a vowel followed by l, r, m, n or ng: "feel", "night", "you", "home",
  "mine";
- a word's last syllable on a short vowel closed by a stop or hiss ("it", "get", "up", "back") gets a **short to
  medium** note (under about 500 ms).

The vowels and consonants come from the pronunciation dictionary already used for stress (ARPAbet per syllable).
"You gotta feel it": you (any), go (short), tta (short), feel (any), it (short to medium).

### 4. The melody laid on

The pitches and the chords that belong to them come from a **different** pattern, drawn as melodies are drawn today
(the recipes' melody sources), and are laid over the recut rhythm with the existing drape (precedents.ts drapeAndPlace:
each rhythm note takes the melody pattern's pitch at that beat, the contour fitted to the singer's range and the
song's key, fit.ts). The section takes that melody's chords, as today. A whole hook (recipe hookWhole: rhythm and
pitches of one hook) is not used for sung sections with written words, since rhythm and melody are always separate
now.

### 5. What the user can do (the Vocal menu)

- **Write lyrics**: new words (step 1), then the current rhythm pattern recut to them (step 3), the melody kept
  (step 4 redone over the new rhythm). On a song with no vocal melody yet, it also draws a rhythm and a melody.
- **New rhythm** (new item): another random rhythm pattern for that section type, recut to the same words; melody
  and words kept.
- **New melody** (today's Change melody): another melody pattern laid over the same recut rhythm; words and rhythm
  kept. The chords change with the melody, as Change melody does today.
- Results apply only when the player is not playing, as tasks do today.

Write melody (a melody with no words) stays as it is.

### 6. Titles

The titler (apps/brain/src/titles/songTitler.ts) asks for short chart-pop titles: a phrase someone would say or sing
("Bad Idea", "Kiss Me Back", "Not Your Girl"), not a poetic image ("Cinnamon Boulevard"). Existing titles are not
changed.

## Where things live (Claude's proposal; the builder may refine)

- arrangement `vocals/`: the length rule (next to stress.ts), the recut (a new module), the rhyme-repeat rule in
  rhyme.ts / checkSectionLyrics; recipes gain the "rhythm only" and "melody only" draws.
- Generator params: per section type the chosen rhythm pattern id and melody pattern id (so New rhythm and New
  melody each redraw one), and the recut rhythm stored as notes with their syllables (like `sungMelody`), so a song
  keeps its exact rhythm when the code changes.
- brain: the lyricist's new prompt and checks; the situation and artist lists as data files; the recent-openings
  check reads the owner's songs from the store.
- web: the New rhythm menu item next to Change melody.

## Test of 2026-11-27 (spike, throwaway)

apps/brain/scripts/try-lyrics-first.ts, 6 stored songs. Round 1 (a literary anti-cliché brief, with scene cards or a
Dickinson poem as inspiration) read like indie poetry: rejected by the owner. Round 2 (the pop brief, plus a random
artist, plus a random situation): the right register, but "Met you at the corner store" opened 11 of the 12 songs
without a situation. No version copied four words in a row from its inspiration. About 1.5 s per song, no reasoning.

## Calls made after the builder check (Claude's; the owner may overrule)

- **New rhythm**: one random draw, recut to the kept words (the recut always succeeds, step 3). A quick edit like
  Change melody, no model call.
- **Songs and sections without written words** keep today's behaviour exactly: Write melody and Change melody use the
  recipes as now (hookWhole included). The split (rhythm and melody drawn apart, both pattern ids recorded) applies to
  sections with written words. New rhythm is offered only on sections with words.
- **Write lyrics on an existing melody, whatever recipe made it** (a whole hook, a curated Original): the pitches and
  chords are kept; its rhythm is the pattern that gets recut. From then on the section counts as split.
- **Melody source weights**: a recipe is drawn by today's weights and only its melody side is used; the rhythm is
  drawn uniformly as in step 2. The bank index data does not change.
- **A hummed chorus (owner, 2026-11-27)**: recut like any pattern. Its pitches (the hum) are kept, its rhythm is
  bent to the words. Change melody still refuses it, as today.
- **Sung takes**: new words or a new rhythm drop the section's sung melody, as a new melody does today.
- **The situation list** ships as the model wrote it; the owner prunes it when convenient (it is data, any edit
  applies at once).
- **Sections of one type with different lengths** (an 8-bar chorus and a 16-bar last chorus): the words and the recut
  rhythm are made for the shortest; a longer section repeats them, as pop choruses repeat.

## Left to the builder

The exact moves and their costs; the syllable range per bar and tempo; the opening-line similarity
threshold; the length thresholds (start at 300 and 500 ms); how the recut handles a pattern with far fewer notes than
the line has syllables (adding and splitting notes are moves; it always fits).
