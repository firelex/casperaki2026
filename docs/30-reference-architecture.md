# 30 — Reference architecture: `open_teamsuzie` (the house template)

> The rebuild follows the conventions of `../open_teamsuzie`, the template all current
> apps are based on. This doc captures the parts that matter for Casperaki so the new
> code looks like every other teamsuzie app. The current `casperaki` (models) app is
> already a working example of these conventions.

## Shape: pnpm monorepo

- **pnpm workspaces** (no Nx/Turbo). `pnpm-workspace.yaml` declares tiers:
  `apps/*/*`, `apps/*/*/client`, `packages/*`.
- Top-level groups: `apps/platform/*` (shared services), `apps/starters/*`
  (app templates), `apps/agents/*` (model/agent services), `packages/*` (shared libs).

## Stack (the defaults to adopt)

| Layer | Choice |
|---|---|
| Language / runtime | **TypeScript 5.7+**, Node 20+, ESM (`"type":"module"`) |
| Package manager | **pnpm 9** |
| Backend | **Express 5**, minimal — `index.ts` (mount routers) + `config.ts` (parse env) + `bootstrap.ts` (`dotenv` then start) |
| Frontend | **React 19** + **React Router 7**, **Vite 7**, `/api` proxy |
| Styling | **Tailwind 4** + **Radix** via **`@teamsuzie/ui`** (electric-violet `#7547fe`); override with `@theme {}` |
| Local data | **SQLite** (`better-sqlite3`) via `@teamsuzie/db-sqlite` (WAL, idempotent `.sql` migrations) |
| Multi-tenant data | **Postgres** + **Sequelize** (only when true multi-tenancy needed) |
| Validation | **Zod**; **TanStack Query** on the client |
| Testing | **Vitest** (ESM-first), colocated `*.test.ts` |
| LLM access | via **`llm-proxy`** service → provider routing + usage tracking |

## Conventions to follow

**App layout**
```
apps/<app>/
  src/            index.ts · config.ts · bootstrap.ts · routes/ · services/ · models/ · middleware/
  client/         src/{main.tsx, App.tsx, index.css, pages/, hooks/} · vite.config.ts (Tailwind + /api proxy)
```

**Frontend↔backend:** plain REST (`GET/POST/DELETE /api/...`); **SSE** for streaming
(chat/long jobs emit `{type:"chunk"|"tool_call"|"tool_result"|"done"}`). No tRPC/GraphQL.

**Config:** no implicit `.env`; `bootstrap.ts` does `import 'dotenv/config'` then
`config.ts` parses `process.env` with typed helpers. `.env.example` is checked in.

**Packages:** shared logic → `packages/*` (importable across apps) via local `link:`
deps; app-specific code stays in `apps/*/src`. UI → `@teamsuzie/ui` extended with app CSS.

**Auth:** `@teamsuzie/shared-auth` (multi-tenant: Organization / User / Agent /
AgentProfile; session+CSRF for browsers, bearer for agents; Redis sessions). Starters
can skip auth (single-user).

## Model/agent serving pattern

Two complementary patterns, both relevant to Casperaki:

1. **`llm-proxy`** — single ingress for text-LLM calls, routes to OpenAI/Anthropic/
   Gemini/local, tracks usage in Redis. Use for any *language* AI (lyric ideation,
   natural-language "make the chorus bigger" editing).
2. **Harness-adapter serving** (as in the current `casperaki` models app + teamsuzie
   `agents/*`) — a uniform `start → generate → result` HTTP lifecycle per model,
   each model an adapter behind one contract. Use for *audio* models (ACE-Step,
   SAM-Audio, SoulX-Singer, Matchering).

Capabilities can be given to an agent three ways: **typed tools** (strict JSON Schema,
in-process), **skills** (`SKILL.md` markdown + `http_request`, loose, drop-in), or
**MCP servers** (external). For Casperaki, audio generation is best modeled as
HTTP services/skills the brain or an agent calls.

## What to copy to start the rebuild

- `pnpm-workspace.yaml` + a root `package.json` with workspace scripts.
- A starter (`apps/starters/starter-chat` for an agentic surface, or
  `starter-ops-console` for a data/tooling surface) as the app skeleton.
- `link:` the shared packages you need: `@teamsuzie/ui`, `agent-loop`, `skills`,
  `approvals`, `db-sqlite`, `shared-auth`, `types`.
- Mirror the current `casperaki` models app for the **audio-model serving** half.

Reference paths: `open_teamsuzie/docs/ARCHITECTURE.md`,
`docs/EXTENSION_MODEL.md`, `apps/starters/`, `packages/ui/`, `apps/platform/llm-proxy/`,
`docker/docker-compose.yml`.
