# Guitar strums: more Virtual Guitarist grooves, guitar in more genres

Approved by the owner 2026-11-25 ("GO AHEAD").

## Why

The Virtual Guitarist bank (recorded chord strums: short/long, up/down, plus fx noises) is 702 converted Ample Guitar
loops and 9 transcriptions. It is lopsided (Metal is a quarter of it), its loops are 1–2 bars, almost all straight
16ths, and it has nothing for EDM, urban or schlager, which never get a guitar at all. The owner wants 30–50 more
grooves wherever a genre is under-represented, and guitar in the genres that lack it.

## Decisions

- **Guitar in more genres.** EDM, schlager and urban get a guitar in about one song in three, from a separate random
  draw so the rest of the roster is unchanged. Urban takes the ballad guitar sounds; schlager, latin and EDM take the
  brightPop guitar sounds. Reversible per genre. A genre only gets the extra guitar once it has an approved pattern-lab
  guitar style (the old bank has nothing for it), so nothing changes until grooves are approved.
- **New pattern-lab kind `guitarStrums`** (family guitar): hits are `[beat, stroke, length]` with stroke one of
  down / up / longDown / longUp, played as the recorded chord strums (`virtualGuitarist` events, the same the old bank
  emits); optional single-string `picks` (the guitarPicks hit format) and `fx` (fx1, fx2, fx4, fx6). Energy low/high as
  the other lab kinds; patterns up to 8 bars (grooves are written as 4-bar phrases with a variation in bar 4).
- **Grooves:** about 230 original grooves (urban 40, schlager 40, EDM 30, latin 40, ballad 40, organicVibes 40; ballad and
  organicVibes mostly 12/8, 6/8 and shuffle feels), each a style with quiet and busy patterns, in batches by genre for
  the owner to approve in the pattern lab. A checker rejects malformed grooves and near-copies of existing patterns.
  Original writing only, no transcriptions of songs.
- **Mixing with the old bank:** for the guitar lane, where the old bank has patterns for the song's genre and tempo,
  approved lab styles and the old bank split 50/50; where it has none, the lab styles always play.
- **fx holes:** the TC Rectifier guitars get fx1–8, cut from their `Default FX.mp3` the way the other guitars' were
  (0.78 s slices about every 4 s). The live player throws, naming the file, when a strum or fx sample is missing, instead
  of skipping it.

## Approaches considered

- Extend `guitarPicks` with strum strokes: rejected, picks play per-string notes through the note sampler; strums need
  the recorded chord samples, a different event type and engine track.
- Add grooves straight into the legacy bank JSON: rejected, no review step and no energy marks.
- New lab kind (chosen): reviewed by the owner, energy-aware, reuses the existing engine path.

## Left to the builder

Exact schema field names, the checker's similarity measure, the lab grid drawing.
