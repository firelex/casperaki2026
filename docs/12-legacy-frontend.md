# 12 — Legacy frontend: `casperaki-fe-rory`

> Origin: `firelex/casperaki-fe-rory` · Vue 3 + Vite + Vuex · ~10,100 LOC across 40
> `.vue` files · last active 2023-04. **The most complete UI** ever built for
> Casperaki — sophisticated, polished, but **visual-only** (no real audio).

## Stack

- **Vue 3.2** (Composition API / `<script setup>`), **Vite 2.9**, **Vuex 4**,
  **Vue Router 4**, **SASS/SCSS**, **mitt** (event bus), **vue-dragscroll**. npm.
- Routes (`router/index.js`): `/` (ProjectsView), `/login`, `/editor`, `/svg-test`.
- State (`store.js`, ~319 lines): a hardcoded demo song — 14 sections, 6 patterns,
  6 transitions, audio state (`play`, `position`, `length: 206`, `bpm: 142`).

## What's built (and genuinely good)

| Surface | File | LOC | State |
|---|---|---|---|
| **Piano roll** | `components/editor/PianoRoll.vue` | 1,251 | ✅ drag/resize notes, marquee multi-select, grid snap (1/4–1/16), copy/delete, octave ruler |
| **Timeline / arranger** | `views/Timeline.vue` | 1,133 | ✅ sectioned song, insert patterns/transitions, mute/delete, expand short sections, chord overlay, playhead |
| **Structure editor** | `views/Structure.vue` | 560 | ✅ drag-reorder sections, insert/delete, duration sizing, "generate structure", "optimise length" |
| **Drum machine** | `components/editor/DrumMachine.vue` | 507 | ✅ 16-step × 6-row sequencer, sound/style selectors, busyness, regenerate |
| **Sound design** | `views/SoundDesign.vue` | 462 | ✅ per-instrument cards (library/style/busyness), launch piano roll / drum machine |
| **Playbar** | `components/editor/Playbar.vue` | 363 | ✅ play/pause, seek, time, BPM selector (110–145), regenerate, mixer toggle |
| **Editor shell** | `views/Editor.vue` | 362 | ✅ tabbed Sound Design / Timeline / Structure |
| **Automation editor** | `components/app/EditAutomation.vue` | 260 | ✅ SVG curve editor, draggable control points |
| **Modal system** | `components/app/Modal.vue` | 251 | ✅ dispatcher for 8 edit modals |
| **Publish** | `components/editor/Publish.vue` | 185 | ✅ privacy toggle, share URL, MP3/WAV/M4A + DAW-export buttons (UI) |
| **Mixer** | `components/editor/Mixer.vue` | 144 | ⚠️ overlay; volume bars largely non-functional |

Plus a rich `components/app/` toolkit: custom dual-axis `Scrollbars`, `Dialog`,
`NumberSelect`, `Select`, `VolumeBar`, `Checkbox`, `Loader`, `GlowBackground`, etc.

Component tree: `App → Editor → {SoundDesign, Timeline, Structure, Playbar, Mixer}`,
with `PianoRoll`/`DrumMachine` as modals and a `Modal` dispatcher fronting all the
insert/edit dialogs.

## The critical gap: no real audio

Playback is a **`setInterval`** ticking a position bar (`Editor.vue`). Clicking notes
updates UI state only — **no Web Audio / Tone.js / engine wired up**. Sound libraries,
regenerate/optimise, export, login, and project save are **UI stubs** (no backend
calls). It is a high-fidelity *visual prototype* of the DAW, not a working DAW.

## Value for the rebuild

This repo is the **UX spec and component reference** for the new frontend. The hard
interaction work (piano-roll note editing, marquee select, timeline arrangement,
drag-reorder structure, automation curves) is already designed and largely solved.

**Caveats for porting:**
- Vue 3 + Vuex + SCSS here; the house template (`open_teamsuzie`) is **React 19 +
  Tailwind + `@teamsuzie/ui`**. So this is a **reference to re-implement**, not a
  drop-in port — the *interaction logic and layouts* transfer, the *framework* does not.
- It assumes a hardcoded store; the rebuild must drive these views from the brain's
  `song.json` and wire playback to the (WASM) engine instead of `setInterval`.

See [`50-engineering-plan.md`](50-engineering-plan.md) and
[`54-phase5-web-frontend-plan.md`](54-phase5-web-frontend-plan.md) for how the UI
slots into the target architecture.
