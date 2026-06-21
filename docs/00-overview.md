# 00 — Overview: the Casperaki repo constellation

Casperaki has accumulated many repos over the years (2020→2026) across two GitHub
orgs (`firelex` and `Casperaki`). This document maps which is which, what's
authoritative, and how the surviving pieces fit together.

## Repos that matter (cloned locally under `~/apps`)

| Local dir | Origin | Layer | Last active | Status |
|---|---|---|---|---|
| `casperaki` | (new, no git) | **Models** + this docs set | 2026-05 | Newest; AI model serving (teamsuzie era) |
| `casperaki2-engine-js` | `firelex/casperaki2` | **Brain / backend** | 2024-04 | ✅ The real generation engine (Node/Express) |
| `casperaki_engine` | `Casperaki/casperaki_engine` | **Audio engine** | 2024-05 | ✅ Native C++/JUCE renderer, builds to WASM |
| `casperaki-fe-rory` | `firelex/casperaki-fe-rory` | **Frontend** | 2023-04 | ✅ Most complete UI (Vue 3, visual-only) |
| `casperaki2` | `Casperaki/casperaki2` | (abandoned rewrite) | 2025-04 | ⚠️ Nx monorepo; types + scaffold only, no real code |

> **Naming caution:** there are **two different repos named `casperaki2`** in
> different orgs. `firelex/casperaki2` (cloned here as `casperaki2-engine-js`) is
> the real Node brain. `Casperaki/casperaki2` (local `casperaki2`) is a 2025
> from-scratch Nx rewrite that never got past scaffolding — ignore it for code,
> but note it as a prior (incomplete) attempt at exactly the rebuild we're doing.

## Other legacy repos (GitHub only, for archaeology)

Not cloned; listed so the lineage is recorded. Most are superseded.

- `firelex/casperaki` (2020), `casperaki1`, `casperaki-fe`, `casperaki-fe-new`,
  `casperaki-fe2` — earlier frontend/engine iterations.
- `casperaki-landingpage`, `-admin`, `-api` (2023) — marketing site stack.
- `firelex/virtualsinger`, `firelex/diffsinger` (2023) — vocal-synthesis experiments.
- `firelex/offlinemixer` (2024) — likely an offline mixdown experiment.
- `Casperaki/matchering`, `Casperaki/choc`, `Casperaki/tracktion_engine` — forks used
  as submodules by `casperaki_engine`.

If the rebuild ever needs the vocal-synthesis path, `virtualsinger` / `diffsinger`
are where to look first.

## How the surviving layers connect

```
┌──────────────────────────────────────────────────────────────────────┐
│ FRONTEND  (casperaki-fe-rory, Vue 3)                                   │
│  Piano roll · drum machine · timeline · structure · mixer · publish    │
│  Visual-only today (setInterval "play", no real audio)                 │
└───────────────┬────────────────────────────────────────────────────────┘
                │ REST (song params, edits)
                ▼
┌──────────────────────────────────────────────────────────────────────┐
│ BRAIN  (casperaki2-engine-js, Node/Express + Postgres + Redis)         │
│  Director → Arrangement → Chords → Patterns → Notator → Lyrics         │
│  GENERATES the full song.json (every note/chord/pattern decided here)  │
│  Also: REAPER .rpp export, ABC→PDF notation, ffmpeg lyric video        │
└───────┬───────────────────────────────────────┬────────────────────────┘
        │ song.json (the contract)               │ .rpp + REAPER CLI render
        ▼                                         ▼  (legacy render path)
┌─────────────────────────────────┐   ┌──────────────────────────────────┐
│ ENGINE (casperaki_engine, C++)  │   │ REAPER DAW (Windows CLI)          │
│  Tracktion Edit + VST hosting   │   │  Old server-side render → WAV/S3  │
│  RENDERS song.json → WAV        │   │  (heavyweight, Windows-bound)     │
│  Matchering mastering           │   └──────────────────────────────────┘
│  Builds to WASM (browser audio) │
│  Pulls samples from brain API   │
└─────────────────────────────────┘
```

### Two render paths existed

1. **Legacy server render** — the brain wrote a REAPER `.rpp` project and shelled
   out to `reaper.exe` on Windows, uploading WAV/MP3 to S3. Heavy and platform-bound.
2. **Engine render** — `casperaki_engine` (C++/JUCE/Tracktion) renders the same song
   data directly, hosts VSTs itself, masters with Matchering, and crucially
   **compiles to WASM** so it can render in the browser.

The engine's WASM path is the strategically interesting one and should be the
basis of the rebuild's audio output (see [`50-engineering-plan.md`](50-engineering-plan.md)
and [`52-phase2-engine-wasm-spike.md`](52-phase2-engine-wasm-spike.md)).

## The key insight (repeated because it matters)

The system has a clean **generate → render** split joined by **one JSON document**
(`song.json` + `inst-*.json`). The brain owns musical decisions; the engine owns
sound. That contract (documented in [`20-song-data-format.md`](20-song-data-format.md))
is the most reusable asset in the entire codebase and the seam the rebuild should
be organized around.
