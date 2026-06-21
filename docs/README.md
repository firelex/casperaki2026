# Casperaki — Rebuild Documentation

> Reference docs for rebuilding Casperaki (AI-assisted traditional music
> arrangement & production) from the ground up on modern foundations.
> Last updated: 2026-06-16.
>
> **Pruned 2026-06-16.** The historical phase/step/spike narrative docs
> (51–56 series) were removed to focus on what's left — they recorded
> completed work and live in git history + the code's own provenance
> comments. The forward-looking work list is **[`06-16-2026-to-dos.md`](06-16-2026-to-dos.md)**.

## Why this exists

Casperaki has a long history across many repos. The valuable, working pieces are
spread across three legacy codebases plus one new one. This `/docs` set:

1. **Captures what each legacy layer actually does** (so we don't lose the hard-won
   logic — procedural arrangement, the song JSON contract, the audio renderer).
2. **Defines the target architecture** — a modern rebuild that follows the
   `../open_teamsuzie` house template.
3. **Gives concrete migration/rebuild plans** mapping old → new.

## The four layers

Casperaki is, and will remain, a **four-layer system**:

| Layer | Role | Legacy repo | New home |
|---|---|---|---|
| **Models** | AI audio models (ACE-Step, SAM-Audio, SoulX, Matchering) | — (new) | `apps/models` |
| **Brain / Backend** | Deterministic arrangement generation, song persistence, lyrics | `casperaki2-engine-js` | `apps/brain` + packages |
| **Engine** | Native audio rendering (Tracktion/JUCE), VST hosting, mastering | `casperaki_engine` | reuse via WASM, or rebuild render path |
| **Frontend** | Arrangement/production UI (piano roll, mixer, timeline, AI clips) | `casperaki-fe-rory` | `apps/web` on `@teamsuzie/ui` |

## Document index

**What's left**
- [`06-16-2026-to-dos.md`](06-16-2026-to-dos.md) — **forward-looking work list**: unported legacy-brain logic + deferred items + verification debt

**System & contract reference**
- [`00-overview.md`](00-overview.md) — the repo constellation, layer map, key insight (the song-JSON contract)
- [`10-legacy-backend-brain.md`](10-legacy-backend-brain.md) — `casperaki2-engine-js` deep dive (generation pipeline)
- [`11-legacy-audio-engine.md`](11-legacy-audio-engine.md) — `casperaki_engine` deep dive (C++/JUCE renderer)
- [`12-legacy-frontend.md`](12-legacy-frontend.md) — `casperaki-fe-rory` deep dive (Vue UI)
- [`13-models-layer.md`](13-models-layer.md) — the current `casperaki` AI-model serving app
- [`20-song-data-format.md`](20-song-data-format.md) — **the song JSON contract** (brain ↔ engine interface)
- [`30-reference-architecture.md`](30-reference-architecture.md) — `open_teamsuzie` house template, the conventions to follow
- [`41-ace-soulx-integration-plan.md`](41-ace-soulx-integration-plan.md) — AI artifact workflow (deferred): ACE-conditioned audio + SoulX vocals
- [`50-engineering-plan.md`](50-engineering-plan.md) — master phased engineering plan (historical context)

**Live scoreboards**
- [`54n-unproven-audio-lanes.md`](54n-unproven-audio-lanes.md) — per-lane render status board
- [`54w-engine-bridge-consolidation.md`](54w-engine-bridge-consolidation.md) — brain→engine bridge overview
- [`57-state-of-port.md`](57-state-of-port.md) — port checkpoint (2026-06-10; partly superseded by the to-dos)

**Active workstreams**
- `57a`–`57e` — plugin-chain / rack hosting (Airwindows Consolidated remap)
- `58a`–`58h` — sound-parity audits (octave / drum-tail / bass-envelope / velocity / union-catalog / climax / fx-taxonomy)

## TL;DR architectural insight

**Generation and rendering are cleanly separated, joined by one JSON document.**

```
 params ──▶ BRAIN (generates) ──▶ song.json ──▶ ENGINE (renders) ──▶ audio
            arrangement/chords/      (the          Tracktion + VST +
            lyrics/patterns          contract)     Matchering mastering
```

- The **brain** decides *what* to play (notes, chords, patterns, lyrics, structure).
- The **engine** decides *how it sounds* (samples, synths, FX, mastering) — it does
  **zero** musical generation; it faithfully renders the brain's JSON.
- Preserve that boundary. It's the cleanest part of the old design and the natural
  seam for a modern rebuild.
