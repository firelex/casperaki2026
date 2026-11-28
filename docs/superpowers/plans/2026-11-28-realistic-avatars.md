# Realistic Avatars Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admins design realistic (MakeHuman) avatars on the Avatars page, built on datigator by Blender, and use
them in music videos beside (never mixed with) anime avatars; everyone in a video stands the same height.

**Architecture:** A new model service `avatar-builder` (harness adapter, runs Blender headless) turns a
`RealisticDesign` into a VRM 1.0 file (game-engine materials, Mixamo skeleton, visemes, tints baked into textures,
textures reduced). The brain runs builds as a background task (`avatarBuild`, admins only), stores saved builds as
`avatars/<id>.vrm`, and passes them to the video engine as a new avatar kind (`vrm`) that the engine stages and
loads beside pack recipes. The engine scales every avatar to one head height.

**Tech Stack:** Blender 4.5.17 + MPFB 2.0.18 + VRM add-on 4.10.5 (datigator, not in git), Python 3 (pure parts
tested with pytest), the serving harness (`apps/models/services/_serving`), brain (Express, zod 3, vitest), web
(React), casperaki-video (Remotion, three-vrm, zod 4, vitest).

**Spec:** `docs/superpowers/specs/2026-11-28-realistic-avatars-design.md`

## Global Constraints

- No fallbacks: a missing asset, an unknown library id, a failed build, export or conversion throws with a message
  naming it.
- Realistic avatars: admins only (the brain's `isAdmin`; web `user.isAdmin`). Others never see the realistic
  controls.
- Only CC0 and CC-BY assets in the curated library; a VRM's author line names "MakeHuman" plus each CC-BY author used.
- A music video uses avatars of one style; the brain refuses a mix (400, code `mixed_styles`).
- Equal height: every avatar in a video is scaled so its head height (`headHeight`, head bone + 0.08 m) is 1.60 m.
- Packs, Blender, MPFB data, built VRMs and thumbnails never in git.
- Shared tree: stage only your own files, together with your commit; never leave anything staged. No local
  `vite build` in `apps/web` (trial builds to a scratch `--outDir`); ship via `deploy/datigator/deploy.sh`.
- Engine changes are committed and pushed in `casperaki-video` and the brain's pin moved (pnpm install with the
  `GIT_CONFIG` insteadOf env).

## Review Focus

1. A design naming a garment, hair or skin that is not in the curated library → 400 naming it (brain) and a failed
   build naming it (service), never a silent default. Test in Task 4 and Task 3.
2. Two garments that cover the same slot (a suit plus jeans) → refused before building. Test in Task 4.
3. Saving a realistic avatar from a build that is not finished or belongs to someone else → 400/404. Test in Task 4.
4. A video with one anime and one realistic avatar → 400 `mixed_styles`. Test in Task 4.
5. A non-admin calling the realistic routes → 403 `admin_only`. Test in Task 4.

---

### Task 1: Equal heights (engine)

**Files:**
- Create: `casperaki-video/src/dancefloor/height.ts`
- Modify: `casperaki-video/src/dancefloor/AvatarVideo.tsx` (move `headHeight` to height.ts; scale avatars in the
  `avatars` useMemo, before the microphone is given)
- Test: `casperaki-video/test/height.test.ts`

**Interfaces:**
- Produces: `EQUAL_HEAD_HEIGHT = 1.6`; `heightScale(headHeight: number): number` (throws unless > 0);
  `equalizeHeight(avatar: Avatar): void` (sets `avatar.root.scale` to `heightScale(headHeight(avatar))`, measured at
  scale 1).

- [ ] **Step 1: Failing test** — `heightScale(1.6) === 1`, `heightScale(1.28) ≈ 1.25`, `heightScale(0)` and
  `heightScale(NaN)` throw /head height/.
- [ ] **Step 2: Run** `npx vitest run test/height.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement** height.ts; call `equalizeHeight` on every built avatar in `DanceFloor`. Dance clips scale
  hips by `avatar.hipsHeight` in the avatar's local units, so they stay right under the root scale; the framing's
  `headOf` measures world height and so sees the scaled value.
- [ ] **Step 4: Run** `npx vitest run` → all pass; render the demo (`render.mjs` from the realistic test with the
  test pack) and check the three stand level.
- [ ] **Step 5: Commit** `feat(dancefloor): everyone in a video stands the same height`.

### Task 2: VRM-file avatars (engine)

**Files:**
- Modify: `src/schema/avatars.ts` (`AvatarVideoAvatarSchema`: exactly one of `recipe` or `vrm`), `src/avatar/build.ts`
  (`buildVrmAvatar`), `src/avatar/useAvatars.ts` (sources), `src/render.ts` (staging), `src/avatar/AvatarStill.tsx`
  (a `vrmUrl` prop for the dressing room preview), `src/dancefloor/AvatarVideo.tsx`, `src/lib.ts` / `src/avatar/index.ts`
  exports.
- Test: `test/avatar-video.test.ts`, `test/render-options.test.ts`

**Interfaces:**
- Produces: avatar entry `{ id, name, sings, recipe }` or `{ id, name, sings, vrm: string }` where `vrm` in the render
  *request* is an absolute file path and in the composition props the staged name `people/<id>.vrm`;
  `buildVrmAvatar(url: string, label: string): Promise<Avatar>` (one VRM 1 part, no culling);
  `AvatarSource = { recipe: AvatarRecipe } | { vrm: string }`; `useAvatars(sources: AvatarSource[], packs)`.
- `avatarPackFiles` ignores `vrm` avatars; `renderAvatarVideo` copies each `vrm` file to `public/people/<id>.vrm`,
  throwing `renderAvatarVideo: cannot stage the avatar file "<path>"` when it cannot.

- [ ] **Step 1: Failing tests** — schema: an avatar with both `recipe` and `vrm`, or neither, fails with
  /exactly one of recipe or vrm/; a `vrm` avatar parses. `avatarPackFiles` on an input with only `vrm` avatars returns
  no packs. A relative `vrm` path in a render request throws /absolute/.
- [ ] **Step 2: Run** `npx vitest run test/avatar-video.test.ts test/render-options.test.ts` → FAIL.
- [ ] **Step 3: Implement** as in Interfaces.
- [ ] **Step 4: Run** `npx vitest run` → pass; re-render the realistic test with `vrm` avatars instead of the test
  pack and compare frames to the earlier test.
- [ ] **Step 5: Commit, push** `feat(avatar): VRM-file avatars beside pack recipes`; move the brain's pin.

### Task 3: The avatar-builder service

**Files:**
- Create: `apps/models/services/avatar-builder/` with `README.md`, `library.json`, `pipeline/__init__.py`,
  `pipeline/design.py` (pure: design → MPFB human info), `pipeline/gltf.py` (pure: alpha modes, author line),
  `pipeline/blender_build.py` (runs inside Blender: from `~/apps/blender/build_vrm.py`, plus baking and texture
  reduction), `pipeline/build.py` (runs Blender as a subprocess, checks its output), `tools/setup_assets.sh`
  (installs MPFB, the VRM add-on and the packs from `~/apps/blender/downloads` into Blender's folders),
  `tools/thumbnails.py`, `tests/test_design.py`, `tests/test_gltf.py`, `tests/test_build_blender.py` (slow, real
  Blender).
- Create: `apps/models/services/_serving/adapters/avatar_builder.py` (stage `build`).

**Interfaces:**
- `library.json`: `{ "skins": [Entry], "hair": [Entry], "eyebrows": [Entry], "eyes": [Entry], "clothes": [Entry & {
  "slot": "top"|"bottoms"|"dress"|"shoes"|"glasses"|"hat", "covers": [slot...] }] }`, `Entry = { id, name, path
  (MPFB asset path), licence: "CC0"|"CC-BY", author }`; hair entries may carry `material` (a colour variant .mhmat).
  Start with the assets the test and the judges used, each checked by a test build.
- `RealisticDesign` (JSON; the brain's zod schema mirrors it): `{ body: { gender, age (18-90), weight, muscle,
  proportions } (0..1 except age), ancestry: { african, asian, european } (sum 1 ± 0.01), face: { jawWidth, chin,
  noseWidth, noseLength, eyeSize, lips, cheekbones, browAngle, feminine } (-1..1), skin, eyes, eyebrows, hair,
  hairTint: "#rrggbb"|null, lips: "#rrggbb"|null, clothes: [ids] }`.
- `design.py`: `to_human_info(design: dict, library: dict) -> dict` (MPFB `human_info` with GAMEENGINE material
  types, rig `mixamo`, targets); `age` years → slider (25 y = 0.5, 90 y = 1.0, 18 y = 0.1875 linear below 25 per
  MakeHuman); face sliders → targets: positive values the `-incr` target, negative the `-decr` (names as in
  `~/apps/blender/judges-final.json`: `chin-width-*`, `chin-prominent-*`, `nose-scale-horiz-*`, `nose-scale-vert-*`,
  `l/r-eye-scale-*`, `mouth-lowerlip-volume-*` + upperlip, `l/r-cheek-bones-*`, `eyebrows-angle-up/down`);
  `feminine` adds Love's set scaled by its value (negative: the opposite targets). Unknown ids raise
  `ValueError("avatar-builder: no <kind> \"<id>\" in the library")`; two clothes covering one slot raise naming both.
- `gltf.py`: `fix_alpha(gltf: dict, cutout_names) -> None`; `author_line(assets) -> str`.
- Blender part: tints baked by pixel arithmetic on the images before export (hair: multiply the hair diffuse by
  `hairTint`; lips: blend `lips` into the skin diffuse through MPFB's `mpfb_lips.jpg` mask, as `build_judges.py`'s
  `tint_lips` does in nodes), every image reduced to at most 2048 px (1024 for clothes, eyes, teeth, brows, lashes).
- Adapter: id `avatar-builder`, port 16517 (or the next free port in the harness list), `kind: json`, stage `build`
  params `{ design }` → `out_dir/person.vrm`, `out_dir/build.json` `{ bytes, credits: [{name, author, licence}] }`.
  Blender path from `BLENDER_BIN` (required, no default).

- [ ] **Step 1: Failing tests** — `to_human_info`: phenotype values, age 25 → 0.5 and 90 → 1.0, ancestry mapped to
  MPFB race keys, `noseWidth: -0.4` → `nose-scale-horiz-decr 0.4`, unknown hair id raises naming it, suit plus jeans
  raises naming both; `fix_alpha` sets hair/brow/lash MASK and others OPAQUE; `author_line` lists CC-BY authors.
- [ ] **Step 2: Run** `python3 -m pytest apps/models/services/avatar-builder/tests -q -k "not blender"` → FAIL.
- [ ] **Step 3: Implement** design.py, gltf.py, library.json.
- [ ] **Step 4: Run** the same → PASS.
- [ ] **Step 5: Slow test** `test_build_blender.py`: builds Mia's design (as `RealisticDesign`) with `lips` and
  `hairTint`, asserts a VRM with expressions aa/ih/ou/ee/oh/blink, no image above 2048 px, file under 15 MB, and
  that the lip pixels changed colour. Run with `BLENDER_BIN=... python3 -m pytest ... -k blender` → FAIL, implement
  blender_build.py/build.py, → PASS.
- [ ] **Step 6: Adapter** — start it under the harness, post a build, get the files back.
- [ ] **Step 7: Commit** `feat(avatar-builder): realistic avatars built in Blender as VRM`.

### Task 4: Brain — designs, builds, saving, videos

**Files:**
- Create: `apps/brain/src/avatars/realisticDesign.ts` (zod schema + library check), `apps/brain/src/avatars/avatarBuildTask.ts`.
- Modify: `userAvatars.ts` (style union), `routes/avatars.ts`, `videoAvatars.ts`, `video/videoInput.ts`,
  `video/videoService.ts`, `tasks/tasks.ts` (kind `avatarBuild`, no song), `bootstrap.ts` + `config.ts`
  (`AVATAR_BUILDER_URL`, `AVATAR_LIBRARY_FILE`).
- Test: `apps/brain/test/avatars.spec.ts`, `apps/brain/test/avatarBuild.spec.ts`, `apps/brain/test/video.spec.ts`.

**Interfaces:**
- `UserAvatar` = anime `{ style: 'anime', recipe, ... }` (stored ones without `style` read as anime) or realistic
  `{ style: 'realistic', design: RealisticDesign, ... }` with its file at `<owner>/avatars/<id>.vrm`.
- Routes (realistic ones admin-only, 403 `admin_only`):
  `GET /api/avatars/realistic/library` (the library without paths);
  `POST /api/avatars/realistic/builds` `{ design }` → the task (kind `avatarBuild`);
  `GET /api/avatars/realistic/builds/:taskId/vrm` (the built file, owner only);
  `POST /api/avatars/realistic` `{ name, singerId, buildTaskId, portrait }` and `PUT /api/avatars/:id` the same →
  copies the build's VRM into place; refused unless that task is the owner's, kind `avatarBuild`, state `done`;
  `GET /api/avatars/:id/vrm` (owner only).
- Build task files are deleted one day after the task ends (the existing task-files cleanup, if any; else a sweep at
  start-up and hourly).
- `videoAvatars`: all chosen avatars one style, else `VideoInputError(400, 'mixed_styles', 'A video uses avatars of
  one style: all anime or all realistic.')`; realistic avatars become `{ vrm: <absolute path> }`.

- [ ] **Step 1: Failing tests** — Review Focus 1-5, plus: old avatars.json without `style` reads as anime; a
  realistic save copies the VRM and `GET /api/avatars/:id/vrm` returns it; the build task calls the service with the
  design and records `person.vrm`.
- [ ] **Step 2: Run** `pnpm -C apps/brain exec vitest run test/avatars.spec.ts test/avatarBuild.spec.ts test/video.spec.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same → PASS; then the brain's whole suite once.
- [ ] **Step 5: Commit** `feat(avatars): realistic avatars (admins): designs, builds, saving, one style per video`.

### Task 5: Web — realistic dressing room and the style switch

**Files:**
- Create: `apps/web/src/pages/RealisticDressingRoomPage.tsx` (+ small `realisticDesign.ts` for defaults and
  labels).
- Modify: `AvatarsPage.tsx` ("New realistic avatar" for admins; realistic cards open the new page), `App.tsx` (route
  `/avatars/realistic/:id?`, admins only), the Video tab's avatar picker (style switch: Anime / Realistic, shown only
  when the user has realistic avatars).
- Test: `apps/web/src/pages/realisticDesign.test.ts` (defaults valid; labels), existing web tests.

**Interfaces:**
- Consumes Task 4 routes, Task 2 `AvatarStill` `vrmUrl`.
- Panels: Body (gender, age, weight, muscle, proportions; Ancestry: African / Asian / European sliders kept summing
  to 1), Face (eight sliders + "Feminine ↔ Masculine"), Skin and eyes, Hair (style, tint, lips colour), Clothes (by
  slot, thumbnails). "Update" starts a build and shows its steps; when done the turnable preview loads the build's
  VRM. "Save" enabled only with a finished build of the current design; the portrait is taken from the 3D view.

- [ ] **Step 1: Failing test** for defaults and labels → run `pnpm -C apps/web exec vitest run src/pages/realisticDesign.test.ts` → FAIL.
- [ ] **Step 2: Implement**, using `@teamsuzie/ui` controls as the anime dressing room does.
- [ ] **Step 3: Run** web tests and a scratch build (`vite build --outDir <scratch>`) → pass.
- [ ] **Step 4: Commit** `feat(web): realistic dressing room (admins) and one style per video`.

### Task 6: Library thumbnails, deploy, live end-to-end

- [ ] `tools/thumbnails.py` renders one small picture per library entry (Cycles, on a neutral body) into
  `~/casperaki-data/avatar-library/thumbs/`; the brain serves them (`GET /api/avatars/realistic/library/:id.png`).
- [ ] Register the service in the boot chain (cron @reboot like svc-speech) with `BLENDER_BIN`; set
  `AVATAR_BUILDER_URL` and `AVATAR_LIBRARY_FILE` in `~/.config/casperaki`.
- [ ] Deploy via `deploy/datigator/deploy.sh` (no running tasks).
- [ ] Live check as the owner: design a realistic avatar, Update, Save; make a music video with three realistic
  avatars (one singing); confirm the video renders, everyone level, the lips and hair tint visible. Send the owner the
  video and the library thumbnails sheet.
- [ ] Commit any fixes; update memory (`makehuman-avatars.md`) and the Agent Notes topic page.
