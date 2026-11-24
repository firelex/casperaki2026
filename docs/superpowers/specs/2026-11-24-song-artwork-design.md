# Song artwork (DeepSeek title → small-sd picture)

Date: 2026-11-24, owner's request: when a song is generated, DeepSeek names it, and a picture for that title is drawn
with segmind/small-sd, run as memory-efficiently as possible, for the song's card.

## What the user gets

Every new song's card (projects page) shows a picture made for its title. While it is drawn the card says "Drawing
the artwork…"; if drawing fails it says so (hover for why). Songs made before this have no artwork.

## How

1. **Title.** As before (src/titles): a song generated without a title gets a placeholder ("Edm in C") and DeepSeek
   names it a few seconds later. A title the user gave is kept.
2. **Picture description.** Once naming is over (named or not), the brain asks DeepSeek, in plain English and without
   reasoning, for a one-sentence description of a cover picture for that title and the song's style (no text, letters,
   logos, real people or brands). The look of a cover ("album cover art, digital painting, …") is added to it.
3. **Drawing.** The image service draws it: svc-artwork (port 16513), the serving harness
   (apps/models/services/_serving) with the `small-sd` adapter, weights in /mnt/d/casperaki-models/segmind__small-sd.
   512×512, 25 steps (DPM-Solver++), guidance 7.5, a seed from the task, so the same task draws the same picture.
4. **Keeping it.** The PNG goes to BRAIN_ARTWORK_DIR (`<task>.png`); the project's artwork state (`projects.artwork_*`:
   drawing / done + file / failed + why) follows the project through saves, and unfinished tasks resume when the brain
   starts. `GET /api/songs/:id/artwork` serves it; the project JSON carries its URL. Deleting the song deletes it.
   `artwork` events on /api/events refresh the project list.

The brain needs ARTWORK_SERVICE_URL and BRAIN_ARTWORK_DIR (both or neither; without them songs get no artwork, and the
brain says so when it starts).

## Memory

small-sd is Stable Diffusion 1.5 with a smaller U-Net. The adapter loads it in half precision with attention slicing
and VAE slicing, and uses model CPU offload: the pipeline lives in CPU memory and each part (text encoder, U-Net, VAE)
moves to the GPU only while it runs. Measured on the RTX PRO 6000 (see below).
