# Hum editor: editable melody and chords, read-only score

Date: 2026-11-24. Builds on [2026-11-23-hum-to-song-design.md](2026-11-23-hum-to-song-design.md).

## Intent

After humming, the owner wants to fix what the transcription or the completion got wrong, and to choose different
chords, before the melody becomes a song's chorus. Seeing the melody as a score helps check it.

## Goals

- On /hum, between "pick a version" and "make the song": edit the melody of the chosen version in a piano roll, change
  any of its 16 half-bar chords, and see a read-only score that follows every edit.
- The song is built from the edited melody and chords.

## Non-goals and anti-goals

- No note editing in the full song editor. Its piano roll stays view-only by design (users are not meant to write
  patterns). The editable piano roll is a separate component used only by the hum editor.
- The score is never edited directly.
- An edit is never overwritten silently: chords do not re-fit on their own after a melody edit, and a new completion
  never touches bars the user hummed or edited.

## Approaches

1. **Editable piano roll on the hum page, score below it (chosen).** Looks like the editor's detail-window piano roll
   and score (`ClipDetail.tsx` PianoRoll, `Score.tsx` with `notation.ts`/abcjs), so the two feel the same; the editing
   is new code that lives with the hum page.
2. Make the editor's own PianoRoll editable behind a flag. Rejected: the editor's roll must stay view-only, and a flag
   invites it to leak into the editor.
3. Edit in the score. Rejected: much more work, and the owner wants the score read-only.

## Decided

**Melody editing** (mouse; 16th-note grid; notes may not overlap in time, since the melody is one voice):
- Left click on an empty spot: add a note there. Its length is the last length used, starting at one beat.
- Right click on a note: delete it (no browser menu).
- Press on a note and drag: move it in time and pitch.
- Long press on a note (about 350 ms without moving), then drag: change its length.
- The new pitch is heard briefly when a note is added, moved in pitch or resized.

**Chords:** the chord row above the piano roll shows the 16 half-bar chords. Click one to get a list of the 46 chords the
fitter knows, best fit to the notes in that half bar first, and pick one. A "Re-fit chords" button re-runs the fitter on
the edited melody for this version (only when pressed).

**Completion:** "Complete a different way" rewrites only bars that are neither hummed nor edited by the user (the
completion service already takes any set of bars to keep). If every bar is the user's, the button is disabled.

**Score:** under the piano roll, read-only, redrawn on every edit, chord symbols above the staff. Engraved by the
existing `Score` component and `notation.ts`.

**Server:** the brain keeps the analysis; edits are sent with the requests that need them:
- `POST /api/hum/song` takes the edited `melody` and `chords` (checked against the user-chorus schema).
- `POST /api/hum/complete` takes the current melody, chords and the bars to keep.
- A new call for "Re-fit chords" and the chord list ranked for a half bar, using the fitter in
  `packages/arrangement/src/hum/`.

## Builder's calls (marked as such)

- Undo (Ctrl+Z) and a "Back to the original" button per version: cheap and edits are easy to get wrong.
- Touch screens: tap a note to select it and show a small delete button; long press and drag to resize, as with a mouse.
- Edits are per version; switching versions keeps each version's edits for this session (not saved anywhere).
- Pitch range of the roll: the melody's range plus some room, as in the editor's roll, growing when a note is dragged
  past the edge.
- Whether the score shows the chord symbols via abcjs annotations or a row drawn above it.
