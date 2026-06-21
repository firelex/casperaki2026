# 13 — Models layer: the current `casperaki` app

> This repo (`~/apps/casperaki`) currently contains the models app. In the rebuild it
> moves to `apps/models/`. New (2026-05), React 19 + Express + Python. The **AI model
> serving** layer, built in the teamsuzie style.

## What it is

A local server + web UI that downloads and runs **full-precision AI audio models**
on this machine, each behind a uniform HTTP contract. It is the newest, cleanest
Casperaki code and already follows house conventions (consumes `@teamsuzie/ui`).

## Stack

- **Web:** Vite + **React 19**, React Router 7, TanStack Query 5, Tailwind 4,
  sidebar shell from **`@teamsuzie/ui`** (linked from `../open_teamsuzie`).
- **API:** **Express** (TypeScript, `tsx`). API on `:16400`, web on `:16401`
  (proxies `/api`).
- **Model serving:** a generic **Python harness** (`services/_serving/harness.py`)
  with per-model **adapters** (`services/_serving/adapters/*.py`), each a uniform
  async job server. `uv` for venv management; CUDA / PyTorch.

## Models wrapped (adapters)

| Adapter | Model | Task |
|---|---|---|
| `ace-step.py` | ACE-Step 1.5 | text-to-music generation |
| `sam-audio.py` | SAM-Audio | sound/stem separation |
| `soulx-singer.py` | SoulX-Singer | voice / singing synthesis |
| `matchering.py` | Matchering (pure DSP, no weights) | audio mastering |

> Note the through-line: **Matchering** also masters in the legacy C++ engine
> (`casperaki_engine`). Same mastering concept, old and new — a natural bridge point.
> And **SoulX-Singer** is a modern answer to the legacy Vocaloid-phoneme vocal path.

## Structure

```
src/web/      React UI — ModelsPage (download/manage), StudioPage (run/generate), api.ts
src/server/   Express — routes/{models,services}.ts, services/{registry,serviceManager}.ts,
              models/{modelLibrary,downloadManager}.ts
services/     _serving/ (harness.py + adapters/) + per-model repos (ace-step, sam-audio,
              soulx-singer, matchering)
```

Generic endpoints: `/api/health`, `/api/models[...]` (list/download/config),
`/api/services/:id/{start,stop,generate,result,file}` — a uniform start→generate→
fetch-result lifecycle per service.

## Role in the rebuild

This is **Layer 1 (Models)** of the four-layer system. In the rebuild it provides the
**AI capabilities** that augment the procedural brain:
- text-to-music & stems (ACE-Step, SAM-Audio) for AI-assisted ideation,
- singing synthesis (SoulX-Singer) for the vocal path,
- mastering (Matchering) for final polish.

Architecturally it already matches `open_teamsuzie` (harness adapters, Studio, generic
`/api/services`), so it's the **template within the family** for how the rebuilt
backend should expose model-backed services. See
[`30-reference-architecture.md`](30-reference-architecture.md),
[`41-ace-soulx-integration-plan.md`](41-ace-soulx-integration-plan.md), and
[`50-engineering-plan.md`](50-engineering-plan.md).

> Background context already recorded in repo memory: serving architecture (harness
> adapters / Studio / generic `/api/services`) and Blackwell/sm_120 integration
> gotchas. Cross-reference there before touching the Python serving layer.
