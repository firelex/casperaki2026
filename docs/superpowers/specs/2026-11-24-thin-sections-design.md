# Thin sections get a partner track — design

Date: 2026-11-24. Approved by the owner in conversation.

## Why

"Sunlit Sidewalk" (brightPop, C, 120 bpm, song `ba189d1762d0d253`) sounds incomplete. Its pad plays one held note per
bar (a legacy `singleNote*` pad style), and the verse lead synth plays a two-bar pattern whose second bar has only two
eighth notes. The verses carry only bass, the one-note pad, the half-empty synth and a conga loop. The clash pass
(`arrangement-polish/clashes.ts`) only ever takes notes away; this is its counterpart, adding where a section is thin.

## Goals

- Sections whose harmony or rhythm is thin get a partner track of the same kind as the thin part (Pad 2, Synths 2, …):
  a different sound, its own pattern, chosen to fill the gaps.
- After each addition, clashes and thinness are checked again, until nothing is thin or the cap is reached.

## Non-goals / anti-goals

- Choruses (or any section) that are already full are left alone; a sparse part inside a full section is not paired.
- No snowballing: at most two added tracks per song.
- Tracks the user edited stay exactly as written (same rule as clashes).
- No new random draws that shift other parts: added tracks fork their own named streams.

## Approaches considered

1. Thicken the existing part (pad single note → chord; fill a near-empty bar). Cheaper, but changes the part's
   character and cannot add a second colour.
2. Switch on a track the song already has but the section leaves off. Changes the section's build-up (sparse verses
   are often deliberate) and depends on what the roster happens to hold.
3. **Chosen (owner's idea):** add another track of the thin part's kind, with a different sound and pattern, then loop
   the checks (clashes? still thin?).

## Design

Runs in `orchestrate` after `resolveArrangementClashes`, as a new `arrangement-polish/thin-sections.ts`.

Measure per section, over tonal non-bass, non-drum, non-vocal parts (pitch resolved from the chord for chord-relative
events):

- **Harmony thin:** on most beats (median over the section's beats) fewer than 3 distinct pitch classes sound.
- **Rhythm thin:** fewer than ~60% of the section's beats have an onset from any part (held notes do not count as
  onsets).

Thresholds live in one `THIN_RULES` object, like `CLASH_RULES`, to tune by ear.

Which part gets a partner:

- Harmony thin → the part carrying the harmony (the pad if it plays; else the most sustained tonal part).
- Rhythm thin → the part with the largest gaps (most beats without an onset among the parts that play).
- A family with no generator for the genre, or no unused catalog sound, is skipped (next candidate).

Adding the partner:

- A new lane of the same family through the selection's lane machinery (name `Pad 2`, `Synths 2`, …), a catalog sound
  the song does not use yet, active only in sections of the thin section's type (all verses alike), the same way the
  sequencer's `addTrack` edit adds a lane.
- Its patterns come from its own rng forks (`thin/<lane>#v<n>`). Up to four pattern variants are written; the one
  kept is the one that fills the most of the thin measure (most beats gaining an onset, most pitch classes added),
  ties to the first. Deterministic.
- Then clash resolution runs again and thinness is measured again. Loop ends when no section is thin, nothing can be
  added, or two tracks have been added.

Track edits: like clashes, the pass runs on the song generated without the edits; edited tracks are laid in as written.
Added lanes appear in `instrumentDefinitions` and the per-section `instruments` maps like any other lane.

## Verification

- Unit tests (thinness measure, partner choice, cap, determinism, edited tracks untouched).
- The 200-song run used for clashes: share of thin sections (harmony / rhythm) before and after, and clash rates must
  not rise.
- Sunlit Sidewalk regenerated from its seed: verses expected to gain Pad 2 (chords) and Synths 2; choruses unchanged.

## Left to the builder

Exact thresholds after the 200-song measurement; how chord-relative events are resolved to pitches (reuse what the
engine adapter or clashes use); how the variant streams are named.
