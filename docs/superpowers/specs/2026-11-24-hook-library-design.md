# Hook library and melody library page

Date: 2026-11-24. Agreed with the owner in conversation.

## Intent

The sung melody of a section comes from precedent banks. The legacy ("remix pattern") banks are transcriptions of real
songs, mixed at generation time (rhythm from one entry, pitch shape and chords from another): n entries give n x n
combinations. We add our own **hooks**: original 8-bar melodies with their chords, written for Casperaki, so they carry
no one else's melody. And a **melody library** page to see, hear and later edit both kinds, the way the sound library
shows sounds.

## Goals

- At least 100 original hooks in one genre-free bank file, in the same format as the legacy banks.
- The generator can use a hook whole (its rhythm, notes and chords together) and can also mix hooks with each other the
  legacy way (rhythm of one, shape and chords of another), so the bank grows as n + n x n. The share used whole is a
  setting in the bank index.
- Hooks are offered only to songs inside the hook's tempo range.
- A melody library page lists both kinds ("Hooks", "Remix patterns"), with filters, and shows any entry in the hum
  editor's piano roll and chord row (read-only here) and the score with chord names, and plays it.
- Hooks are not used in songs until the owner has auditioned them on the page (the bank index does not list the hooks
  bank until then).

## Non-goals (this round)

- Editing entries on the page and saving them (next step, via propose-and-approve as in the pattern lab).
- Public-domain melodies (possible later).
- Changing how the legacy banks are used.

## Anti-goals

- No melody taken from a copyrighted song, whole or recognisably.
- No change to what existing songs generate while the hooks bank is not listed in the index (same random draws).

## Approaches

1. **One hooks file in the legacy format plus a few new properties; the bank index lets a section draw from several
   melodic banks; hooks are used whole or mixed (chosen).** Fits the existing loader and the generator's merge.
2. Hooks per genre. Rejected: a hook is a hook; the melodic banks are already chosen by section, not genre.
3. Hooks only as melodic sources (mixed with genre rhythm banks). Rejected: the hook's rhythm and pitches belong together.

## Decided

**Hook entry** (`data/vocals/precedents/mlDataRaw-hooks.json`): the legacy precedent shape (`id`, `properties`,
`melody`, `chords`), key C, beats from the start (4 per bar), 8 bars (`start 0, end 8`) or with a lead-in bar
(`start 1, end 9`). Melody in the banks' register (as the legacy banks: midi 48 is written "c4"; verses about 40-55,
choruses up to about 64). Extra properties: `kind: "hook"`, `tempoMin`, `tempoMax`, `feel` (a short tag for filtering).
`type` is Verse, Pre-chorus, Chorus or Bridge. Minor-mode hooks are written in A minor (the relative of C), as the
legacy banks do.

**Hooks are written** in a compact text form (pitches with lengths, chords per bar or half bar) and converted to the
bank file by a script that also checks them: notes in the key (a few chromatic notes allowed), chord tones on strong
beats, range at most a 12th, no overlapping notes, exact length, chord symbols the arrangement can read.

**Coverage:** about 40 choruses, 30 verses, 20 pre-choruses, 10+ bridges; slow, mid and fast tempo ranges; about one
in five with a lead-in bar; a spread of feels (anthem, bouncy, tender, driving, groove, minor and dark).

**Generator:** a bank-index rule's `melodic` may list several banks. When the hooks bank is in play, a picked hook is
used whole with probability `hookWholeShare` (bank-index setting) and otherwise mixed with another hook. When the rule
has one bank, the code path and its random draws are unchanged.

**Melody library page** (`/melodies`, header link "Melodies"): two tabs, Hooks and Remix patterns (each legacy bank a
filter), filters for section, tempo, feel; the selected entry in the piano roll (read-only), the chord row and the score
with chords; Play. Brain: `GET /api/melody-library` (list, paged) and `GET /api/melody-library/:bank/:id`.
