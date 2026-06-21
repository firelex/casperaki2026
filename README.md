# Casperaki

Casperaki is being rebuilt as a modern pnpm/TypeScript monorepo for deterministic
song generation, real audio rendering, and AI-assisted music production.

The current working app is the **models layer**: a local React + Express + Python
server for downloading and running audio models such as ACE-Step, SAM-Audio,
SoulX-Singer, and Matchering. It now lives at `apps/models`.

## Workspace

```text
apps/
  models/          # current AI model serving app
packages/
  song-schema/     # Phase 1 shell: canonical song contract
  music-theory/    # Phase 3 shell: chord/note/time primitives
  arrangement/     # Phase 3 shell: deterministic generators
docs/              # rebuild architecture and phase plans
```

Start with [docs/README.md](docs/README.md) for the rebuild map.

## Prerequisite: shared UI

`@teamsuzie/ui` lives in the sibling `../open_teamsuzie` monorepo and is consumed
through a local `link:` dependency. Build it once before running Casperaki:

```bash
cd ../open_teamsuzie
pnpm install --filter "@teamsuzie/ui..."
pnpm --filter "@teamsuzie/ui..." build
```

Re-run the build after pulling UI changes.

## Setup

From this repo root:

```bash
pnpm install
```

## Run the models app

```bash
pnpm dev:models
```

The API listens on `http://localhost:16400` and the web UI on
`http://localhost:16401`.

Useful commands:

```bash
pnpm typecheck
pnpm build
pnpm --filter @casperaki/models dev:server
pnpm --filter @casperaki/models dev:web
```

## Configuration

The models app reads `apps/models/.env` (see `apps/models/.env.example`).

| Var | Default | Purpose |
| --- | --- | --- |
| `CASPERAKI_PORT` | `16400` | API server port |
| `CASPERAKI_CLIENT_PORT` | `16401` | Vite dev server port |
| `CASPERAKI_DOWNLOAD_DIR` | `~/models` | Where downloaded models are written |
| `CASPERAKI_MODEL_DIRS` | `~/models,~/Models,~/.cache/huggingface/hub` | Folders to scan for local models |
| `HF_TOKEN` | - | Optional token for gated/private Hugging Face repos |

## Docs

- [docs/50-engineering-plan.md](docs/50-engineering-plan.md) - master rebuild plan
- [docs/51-phase1-song-schema-plan.md](docs/51-phase1-song-schema-plan.md) - next implementation phase
- [docs/13-models-layer.md](docs/13-models-layer.md) - current models app details
