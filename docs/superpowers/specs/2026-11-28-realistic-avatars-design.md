# Realistic avatars beside the anime ones

> **Superseded in part (owner, 2026-11-28, after seeing the realistic test video):** "I want to keep the dancers as
> anime. Just the judges as humans. Unless we find good VRoid judges." Performers (singers and dancers) stay anime;
> realistic people are for the casting judges. Kept: the avatar builder service, the engine's VRM-file avatars and
> equal heights (casting uses them). The realistic dressing room stays only as an admin tool reached by its address
> (no button). Casting: realistic judges with anime singers (the "casting takes the singer's style" rule below no
> longer holds).

Date: 2026-11-28. Status: design; the owner's words are quoted, my calls marked **(my call)**. Builds on
`2026-11-27-avatars-design.md` (anime avatars from Character Studio packs, dressing room, avatar videos) and
`2026-11-28-video-modes-casting-design.md` (casting; its "Judges" look is replaced by this design).

## Intent

The owner does not want only anime ("No anime style, no.") but liked the anime singers ("I quite liked them"), so:
"give the user the option to use either the old or the new style". The new style is realistic people made with
MakeHuman. Users design them ("will users be able to configure/design them?" — yes). Everyone in a video stands the
same height ("the singers and dancers … all need to be the same height"; "I would scale everyone - judge or
performer"). Anime characters may be cast too ("I would allow anime characters in the casting show, too").

The test on 2026-11-28 proved the path: MakeHuman people built and converted in Blender on datigator render in the
existing avatar video unchanged (`~/casperaki-data/judges/realistic-singers-test.mp4`).

## Goals

- Each avatar has a **style**: `anime` (today's, Character Studio parts) or `realistic` (MakeHuman).
- A **realistic dressing room** on the Avatars page: body, face, skin, hair, eyes, clothes; built on the server.
- **Equal heights**: every avatar in a video (dancers, singer, judges) scaled to one height.
- **Videos in one style**: a music video uses avatars of one style; a casting video takes the singer's style, with the
  judges in that style.
- The four judges in both styles: realistic as approved (`~/apps/blender/judges-final.json`), anime finished from the
  first looks (`~/casperaki-data/judges/judges.json`, with the owner's later notes: Ice black hair, sunglasses, black
  jacket; Nicky wilder hair; Love flashier; Bob white hair).

## Non-goals

- Live slider preview in the browser (MakeHuman runs in Blender; changes are built on the server).
- Converting existing anime avatars to realistic ones (they stay as they are).
- Mixing styles in one video.

## Anti-goals

- Realistic people that imitate real persons (the judges' profiles name real TV judges as inspiration: never their
  likeness or names; users may not upload photos or likenesses for realistic avatars).
- Assets whose licence forbids commercial use (only CC0 and CC-BY packs; CC-BY credited).
- Fallbacks: a garment that does not fit, a failed build or conversion, fails with a message naming it.

## Constraints

- Blender 4.5.17 LTS, MPFB 2.0.18 and the VRM add-on 4.10.5 on datigator (`~/apps/blender`, set up by the owner's
  scripts); the asset packs in `~/apps/blender/downloads` (licences: CC0 or CC-BY); loaded into MPFB's data folder.
  None of this is in git; the build scripts are (below).
- The converter recipe that works (`~/apps/blender/build_vrm.py`, to move into the repo): game-engine materials, the
  Mixamo skeleton (the dance clips' own), MPFB's export copy with Meta visemes and ARKit face units, mask modifiers
  kept, VRM 1.0 humanoid bones assigned automatically, expressions bound on every mesh carrying the shape, and the
  glTF `alphaMode` rewritten (hair, eyebrows, eyelashes `MASK`; all else `OPAQUE`).
- One GPU shared with singing, music and speech: builds run as background tasks, one at a time, in the same queue.
- A realistic avatar file is about 36 MB (large textures): to be reduced (textures 1k-2k) before it reaches browsers.

## Approaches

1. **Server-built realistic avatars, both styles kept (chosen by the owner).** Blender builds each realistic avatar
   from the user's choices; the result is a VRM the existing engine and dressing room viewer load like anime parts.
2. Realistic only, anime retired: one system, but the owner wants to keep the anime style.
3. A MakeHuman port to the browser for live sliders: MakeHuman's targets are vertex offsets that could be applied in
   three.js, but clothes fitting, proxies and materials are a large port. Not now **(my call)**.

## Decided details

### Avatars

`UserAvatar` gains `style: 'anime' | 'realistic'` (existing ones are anime). A realistic avatar keeps its **design**
(a `RealisticDesign`, below) and its built files: `avatars/<id>.vrm` (converted), the portrait, and front and side
preview pictures. Its name and voice (singer) work as for anime avatars.

`RealisticDesign` **(my call)**, every value checked against the library on the server:
- body: `gender` 0..1, `age` (years 18-90, stored as MakeHuman's slider), `weight`, `muscle`, `proportions` 0..1, an
  ancestry mix (shown as "African", "Asian", "European"; MakeHuman's african/asian/caucasian) summing to 1. No height
  slider: everyone is scaled to one height in videos **(my call)**;
- face: up to eight friendly sliders mapped onto MakeHuman targets (jaw width, chin, nose width, nose length, eye size,
  lip fullness, cheekbones, brow angle) and one "more feminine / more masculine" slider that moves several of them;
- skin (one of the natural skins, independent of the ancestry mix), lip colour (optional), eye colour, eyebrows;
- hair (style and colour variant, or a tint);
- clothes: one per slot (top, bottoms or dress, shoes, glasses, hat), each from a curated list (below).

The judges are not `RealisticDesign`s: their specs use raw MakeHuman targets (`judges-final.json`) **(my call)**.

### The curated library **(my call)**

MakeHuman's clothes carry no slot and some clip through others, so users pick from a curated list kept in the repo:
for each asset its id, slot, which other slots it covers (a suit covers top and bottoms), its licence, author and a
thumbnail. Assets are added after a test build looks right; the owner sees the list's thumbnails once. A VRM's author
line names MakeHuman plus the CC-BY authors of the assets it uses, not "CC0".

### Owner's answers (2026-11-28)

- Colours: **bake them**. Lip colour and hair tints (and the judges' grey hair) are baked into the textures before
  export, so the video matches the approved pictures; users get lip colour and hair tint too.
- Who builds: **admins only for now** (like casting, until the GPU load is known). Other users see anime avatars only.

### The realistic dressing room

On the Avatars page, "New realistic avatar" next to "New avatar" (anime). Panels: Body, Face, Skin and eyes, Hair,
Clothes (thumbnails from the packs, by slot). "Update" builds the person on the server (about 30 s) and shows a turnable 3D preview of the converted avatar, the
look the videos will have **(my call: no Cycles pictures that look better than the video)**. "Save" is possible only
after a build and stores that build; unsaved builds are deleted after a day. The build is a
background task with its steps shown, like Add a singer.

### Equal heights

The engine scales each avatar's root so that its standing height (top of the head bone plus a fixed allowance)
equals one height for the whole video (1.70 m **(my call)**). Applied to every avatar in every video: dancers, singer,
judges, both styles. The hips height that scales dance clips and the head height that frames the camera are measured
after scaling.

### How the engine receives a realistic avatar **(my call)**

A new kind of video avatar beside the pack recipe: `{ kind: 'vrm', file }`, staged from the user's avatar folder (and,
for the judges, from the engine data folder). No pretend packs.

### Styles in videos

- Music video: the Video tab shows the avatars of one style at a time (a style switch); the brain refuses a mix.
- Casting: the singer's style decides the judges' style; anime and realistic singers may both be cast.

### The judges

Fixed characters shipped with the engine data on datigator (not in any user's library), in both styles:
- realistic: `~/apps/blender/judges-final.json`, built and converted by the same scripts;
- anime: recipes from the Character Studio packs, finished to the owner's notes, with the sunglasses accessory for Ice.

### Credits

CC-BY assets used by an avatar are listed with the avatar; a video's credits list the CC-BY assets on screen in it
(the end card) and the About page lists all **(my call)**.

### Order of work **(my call)**

This plan: realistic avatars, the curated library, the dressing room, equal heights and the style switch for music
videos, ending in the live end-to-end check. The judges in both styles come with the casting plans (the casting design
is updated to point here); one round of judge pictures goes to the owner then.

### Licences

The CC0/CC-BY rule covers the realistic style. The anime packs keep their status from the 2026-11-27 design (licence
unknown, datigator only) **(my call; flagged to the owner)**.

## Left to the builder

The service shape (a Blender adapter on the serving harness, like the other model services, in
`apps/models/services/`, with a setup script that installs the packs into MPFB from `~/apps/blender/downloads`),
texture reduction, the thumbnails, the credits end card (new work), how the dressing room loads the library list, and the order of work. A
live end-to-end check (a user designs a realistic avatar, it sings in a video beside an anime-free cast) before done.
