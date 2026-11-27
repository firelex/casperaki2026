# Add rap vocals: ACE-Step raps over chosen sections, separated, best take kept

Owner's request, 2026-11-27 (overnight, owner asleep): "Add rap vocals, which use Ace to generate vocals, then source
separate them (maybe try a prompt that minimizes the backing track). We'd have to generate them per segment and allow
the user to pick the segments. Can we condition this with lyrics? Not critical, but if possible, make it optional."
The calls marked *(my call)* were made without the owner and are open to change.

## What the spike showed (apps/models/ace-vocal-tests/rap, outputs /mnt/d/casperaki-models/ace-rap-tests)

Song 36969fa2 (120 bpm, C), ACE-Step 1.5 base, lego `vocals`, the ACE layer adapter's settings; scored by separating
each take with BS-RoFormer and transcribing the vocal with Whisper large-v3 (word recall of our lines).

- **Words are followed.** With words, ACE raps them; per section it lays one line per 2 bars, on the bar lines.
- **No words gives gibberish** ("biscuit, vanilla, soup"). So a section without words gets words written for it
  (the brain's language model) *(my call)*: the words stay optional for the user, never for ACE.
- **Over the whole song, ACE ignores the section tags** (it raps from 0:00, whatever the tags say). So rap is made
  **per section**: the section's stretch of the render is the context, its words the lyrics.
- **Per section it is hit and miss**: over 6 seeds, recall 0.0–0.9 (mean 0.45); some takes are silent or copy the
  backing. Guidance 12 instead of 7 barely helps (mean 0.50). So each section is made **several times (4 takes)** and
  the take with the most words heard (then the cleanest separation) is kept; if none reaches half the words, 4 more,
  up to 12; then the task fails naming the section and what was heard.
- **The "a cappella, dry, no instruments" caption does not reduce bleed** reliably (6.9 vs 7.3 dB over a whole song;
  per section 0–36 dB). It is kept in the caption, and every take is **separated with BS-RoFormer** (the vocal stem is
  kept).

## What the user sees

- **Add rap vocals…** on the Vocal track's right-click menu (next to Add ad-libs…).
- A dialog: the style (default "male rap vocals, confident hip hop flow"), the sections, each a checkbox (verses
  ticked at first) *(my call)*, and for each ticked section an optional box for its words, one line per 2 bars
  ("leave empty to have 4 lines written").
- A task on the Tasks page with its steps: Render the song, Write the rap's words (only when some are empty: the words
  are shown in the step), per section "ACE raps <section>" with the words heard, Separate and pick, Cut and store.
- Result: an audio-only track "ACE Rap" with one clip per chosen section, like other ACE layers.

## How it works

1. Brain task `aceLayer` with instrument `rap`: `sections` (required), `rapWords` (section → lines, optional per
   section), `words` (style).
2. Render the song as it is (the existing ACE layer render).
3. Words: sections without words get `round(bars / 2)` lines from the language model, in rhyming couplets, every word
   in our pronunciation dictionary; kept in the task folder so a resumed task reuses them.
4. svc-ace (ace-layer adapter) with `sections: [{name, start, end, lyrics}]` and `takes: 4`: per section, the render's
   stretch (made 10 s long at least by taking more of the song after it, or before it at the end) → 4 lego takes with
   seeds seed, seed+1, … → a picker run in svc-vocals' venv (tools/pick_rap_take.py: BS-RoFormer + Whisper) separates
   each take and scores it → the best vocal, cut to the section, is placed in a full-length silent track.
5. The brain cuts that track into one clip per section and stores it, as for every ACE layer (levelled to -24 LUFS,
   mixed as `vocalsLaSinger`).

## Left open

- The render includes the song's own lead vocal; where the lead sings in a chosen section, the rap goes over it.
- Words written by the model are not put on the song's lyrics (they are in the task's step).
