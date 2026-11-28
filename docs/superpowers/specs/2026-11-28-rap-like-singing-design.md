# Rap like singing: write rap lyrics, rap, its own track; sections for Sing and Rap; sung parts muted under rap

Owner, 2026-11-28: "this should all happen analogously to singing. So write lyrics, rap, separate track. For both
singing and rapping we should allow the user to specify the segments. Singing should default to all, rapping should
default to verses if a singing track is present and otherwise the whole song. Also, when a rap is present in a segment,
I would by default mute the relevant sung parts, but the user can right-click on and reactivate." Muted: "both leads
and backing".

Follows docs/superpowers/specs/2026-11-27-rap-vocals-design.md (Add rap vocals, lego), which this replaces.

## Why repaint, not lego (spike 2026-11-28, apps/models/ace-vocal-tests/rap/repaint.py, score_repaint.py)

Electric Daydream verse1, the same 4 lines, 8 takes each, scored by the live picker (BS-RoFormer + Whisper recall):

| ACE mode | mean words heard | takes ≥ 68 % |
|---|---|---|
| repaint, base model, 16-bar window (4 bars before, the verse, 4 after) | 65 % | 5 of 8 (best 97 %) |
| lego, base model (today) | 22 % | 1 of 8 |
| repaint, turbo model | 1 % | 0 (made-up words) |

A fast 8-line verse (one 15-18 syllable line per bar) gave 34 %: ACE raps about half of it. One line per 2 bars stays.

## Approaches

- **Steps like singing (chosen by the owner):** Write rap lyrics (words kept in the song, editable), then Rap (uses
  them), result on its own track.
- One dialog that writes and raps in one go (today's Add rap vocals): rejected by the owner's "analogously to singing".

## What the user sees

Vocal track menu: Write melody, Write lyrics, **Sing…**, Transcribe melody, Add ad-libs…, **Write rap lyrics…**,
**Rap…** (replaces "Add rap vocals…").

- **Sing…** (the singer dialog) gets section tick boxes: every section with a melody, all ticked at first. Only the
  ticked sections are sung; the other sections keep the takes they have. (Today every Sing re-sings everything.)
- **Write rap lyrics…**: style ("male rap vocals, confident hip hop flow" at first), section tick boxes: the verses
  ticked when the song has sung takes, otherwise every section. The language model writes the words of the ticked
  sections (one line per 2 bars, rhyming couplets, as today's rapWords.ts); other sections' rap words are kept.
- **Rap…**: style, section tick boxes (ticked at first: the sections that have rap words), each ticked section's words
  shown and editable. A ticked section with no words disables the button ("write rap lyrics first", as Sing needs
  written lyrics). The words each section was rapped with (edits included) are saved into the song when the rap lands (my call: simpler than saving first; a failed rap keeps them in the task, which retry raps again). ACE raps each ticked section; the clips land on
  the track **"Rap"**, one per section; rapping a section again replaces its clip.
- **Muting:** when a section has a rap clip, the sung takes there (Vocal, Backing vocals 1 and 2) are muted, both when
  the rap lands and when a later Sing makes takes in that section. Right-click a clip: **Mute** / **Unmute** (any take
  clip: sung, rap, ACE layers). Muted clips are greyed, silent in playback, and left out of the render and export. The
  mute is saved with the song.

## How it is built (my calls)

- **Rap words** live beside the sung words in the generator settings: `params.params.rapLyrics` (section name →
  lines), next to `lyrics`.
- **Mute**: an optional `muted: true` on the AI artifact (the take). Left out of the clips that render and live
  playback are built from (packages/engine-adapter/src/audio-clips.ts and wherever the web builds its audio clips).
- **svc-ace rap** switches from lego to repaint on the base model: per section a window of the section with 4 bars of
  song before and after (as far as the song goes), the section repainted with its own lines (not repeated), caption
  "<genre> song with <style>, rap verse over the beat, <bpm> bpm, <key>". Then as today: 4 takes a round up to 12,
  separated and heard, the clearest kept, fewer than 40 % of the words heard fails. Checked live 2026-11-28: repaint
  gave no words over a 4-bar bridge (4-9 % in 8 takes, also when repainting 8 bars), so sections under 8 bars are
  still made by lego on 8 bars of song with their lines repeated (48 % on that bridge); 8 bars and more by repaint.
- Write rap lyrics is a brain task of its own (like writeLyrics); Rap stays the aceLayer task with instrument `rap`,
  now taking its words from the song.

## Not in this change

Sung lyrics stay written for all sung parts at once (Write lyrics has no section choice); the rap's words are not
shown on the timeline (they are in the Rap dialog).

## Where it ended up (2026-11-28, after the owner listened; "That works.")

- **Rap, not singing:** ACE repaints over the song rendered without its takes (drums, bass, chords: it stays in the
  key), with ACE's own rap tags `[Verse - rap]`, `[spoken word]` ("Rap/recitation" in its docs), `[high energy]`
  and the caption "hip-hop, rap, <style>, fast high-energy rap, aggressive punchy delivery, rapid-fire spoken word
  flow on the beat, punchy drums, no singing, no sung melody, <bpm> bpm". Without the tags the rap was sung.
- **Density:** one short line per bar, 8-11 syllables (the owner's chosen 8-line verse had 9-11 a line, 79 in all;
  102 "had too many words").
- **Words:** written as rap, not song lyrics (apps/brain/src/ace/rapWords.ts): short punchy phrases, syncopated,
  one or two rhymes inside each couplet (checked), multi-syllable rhymes, no fillers.
- **One voice:** ACE's reference audio for every rap, apps/models/services/ace-layer/voices/rapper_male.flac (the
  separated rap of the 8-line test take the owner liked).
- **Short sections** (under 8 bars) are repainted on 8 bars with their lines repeated, only the section kept (lego
  was "much slower"); a rap running past its section is cut at its quietest moment in its last second.
- Live check, Electric Daydream verse1 + bridge1: 96 % and 100 % of the words heard, about 1.5 minutes.
