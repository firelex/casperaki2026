# Avatars: a dressing room, a library with voices, and a 3D dance floor video

Date: 2026-11-27. Status: the owner asked for it ("build on this basis", then left me to carry on alone).
The calls marked **(my call)** were mine while the owner was away; they can be changed.

## Intent

The owner wants avatars for the music videos, made the way character apps do it: pick hair, eye colour, skin,
clothes and shoes, see the character turn in 3D, and save it. Each avatar can carry one of the user's singers (its
voice). The first video to use them is a dance floor video; later there will be more scenes and a storyboard where
the user plans the shots.

## What the owner decided

- Build on Character Studio (M3-org, MIT) and the public Character Studio part packs Drophunter and Neurohacker
  (`memelotsqui/character-assets`): 10 hair styles a pack in ~50 colours, ~33 eye colours, 20 skin tones, tops,
  trousers, skirts, jackets, shoes and accessories in 7 colourings each.
- Detail matters: hair, eye colour, lips "etc." too. (The packs have no lip or face-shape choice: see open points.)
- The packs' licence is **unknown for now**: they are never committed to any repo and are kept on datigator only
  (`~/casperaki-data/avatar-packs/`), like the sample library.
- Avatars get voices: a user's avatar names one of their singers (built-in or their own).
- First use: the dance floor video.

## Approaches considered

1. **Embed the Character Studio app** (host its build, open it in a frame, take the exported VRM file). Rejected:
   it brings wallets, NFT minting and Solana code along, and an exported file can't be edited again.
2. **Import Character Studio's `CharacterManager`** into the website. Rejected for now: same wallet and NFT imports,
   React-version conflicts the project itself works around, and no published package.
3. **(chosen, my call) Our own small assembler for Character Studio's pack format.** Character Studio builds an
   avatar by loading one VRM file per chosen part (each with the full skeleton), tinting it or swapping its
   texture, stacking them, and playing the same animation on every part. That is ~200 lines with `three` and
   `@pixiv/three-vrm`. An avatar is saved as a **recipe** (pack, the part chosen in each group, colours, texture
   choices), not as a 3D file: small, editable later, and the website and the video renderer build the same avatar
   from it with the same code.

## Design

### The avatar recipe (casperaki-video `src/avatar/recipe.ts`, shared)

`{ pack: 'drophunter' | 'neurohacker', parts: { <group>: <item id> }, colors: { <group>: '#rrggbb' },
textures: { <texture collection>: <item id> } }`, checked against the pack's own manifest (every group, item and
colour must exist; required groups `body` and `eyes` present). Eye colour and skin are texture choices; hair and
clothes take a colour tint where the pack allows it.

### Assembler (casperaki-video `src/avatar/`, exported as `@casperaki/video/avatar`)

Imports only `three` and `@pixiv/three-vrm` (no Remotion), so the website can use it too. Reads a pack manifest
from a base URL, loads each chosen part's VRM, applies texture choices and colours as Character Studio does, and
returns one `THREE.Group` with the list of the parts' VRMs. A `pose` function sets humanoid bone rotations on every
part's VRM at once (each part has the same skeleton), and `setMouth(open)` / `blink` drive the VRM expressions
`aa` and `blink` on the parts that have them (the body).

### Dancing (my call)

There are no dance clips in Character Studio or its packs (only idle, walk and wave), and Mixamo clips must be
downloaded by hand with an Adobe account. The first version dances with **procedural moves on the humanoid
skeleton, locked to the song's beat**: bounce, sway, step-touch, arms up, clap, fist pump, head nod, and so on, as
pure functions of the beat position (like the cartoon dancers' moves). Mixamo clips can be added later as another
kind of move.

### Singing

The avatar whose singer sang the song's vocals (its latest Sing) is the lead: it stands front and centre and opens
its mouth with the sung lyrics (the VRM `aa` expression following the timed lyric lines' syllables). Other avatars
dance around it. Without a matching avatar, nobody sings and all dance.

### Library (brain)

- `BRAIN_AVATAR_PACKS_DIR`: the packs (each a folder with `manifest.json`). `GET /api/avatar-packs` lists them,
  `GET /api/avatar-packs/<pack>/<file>` serves their files (signed-in users only; the website builds avatars from
  them).
- The user's avatars: `<BRAIN_SINGERS_DATA_DIR>/<owner>/avatars.json` (with a portrait PNG per avatar), seen only by
  their owner. `GET/POST /api/avatars`, `PUT/DELETE /api/avatars/:id`, `GET /api/avatars/:id/portrait`. Each:
  `{ id, name, recipe, singerId | null, createdAt, updatedAt }`; the singer must be one the user can sing with.

### Website

- **Avatars page** (next to Singers): the user's avatars as cards (portrait, name, voice), New avatar, Edit,
  Delete.
- **Dressing room**: a 3D view of the avatar turning slowly (drag to turn), pack choice (two bodies: Drophunter and
  Neurohacker), then one row per group (hair, top, jacket, trousers, shoes, accessories) with the pack's thumbnails,
  colour swatches under the chosen part, eye colour and skin swatches; a name; a voice dropdown (the user's
  singers); Save takes a portrait from the 3D view.

### Dance floor video (casperaki-video `src/dancefloor/`, style `avatars` in Casperaki)

A 3D club: a glossy dark floor with lit tiles pulsing on the beat, moving coloured spotlights, haze, a DJ booth,
the lead avatar front and centre and up to 4 others dancing around it, cameras cutting with the song's sections
(wide, the lead close up when singing, slow orbit in choruses), and the console video's lyric band and logo. The
render stages only the files the chosen avatars use.

In the Video tab: a new style "Avatars on a dance floor" with a choice of which of the user's avatars appear
(default: all, up to 5).

## Open points (for the owner)

- **Lips and face shape**: the packs have one face each, so lip colour needs a lip mask painted for each pack's
  face texture, and face shape needs morph targets. Not in the first version.
- **The packs' licence** is unknown: fine for trying it out on our own site, not for selling videos until known.
- **Dance clips** (Mixamo, or dance made from the song by a model like EDGE) as a later step.
- Storyboarding and more environments come after the dance floor works.
