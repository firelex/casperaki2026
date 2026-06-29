# AGENTS.md

This repo is worked on by coding agents and humans. Read this file before
editing. Then read any nested `AGENTS.md` in the area you touch.

## Reuse `open_teamsuzie` — do not reinvent

The sibling monorepo `../open_teamsuzie` is a shared platform of vetted,
production packages. **When a capability already exists there, use it. Do not
build a parallel implementation in this repo.**

This applies in particular to:

- **UI** — `@teamsuzie/ui` (buttons, inputs, cards, dialogs, `LoginForm`,
  chat thread, etc.). Reach for these primitives before writing a new component.
- **Auth** — `@teamsuzie/shared-auth` (users, organizations, sessions,
  middleware, OAuth/OIDC, password hashing). Wire to it; don't hand-roll auth.
- **Cross-cutting platform concerns** — crypto, db clients, theme, types, and
  the other `packages/*` in `open_teamsuzie`.

Before writing a new component, helper, model, or middleware:

1. Search `../open_teamsuzie/packages/*` for an existing one.
2. If it exists, consume it (via the workspace `link:` / `workspace:*`
   dependency) and wire it up.
3. Only build locally when nothing suitable exists — and prefer extending the
   shared package over forking it. If you find yourself copying teamsuzie code
   into this repo, stop: depend on the package instead.

Reusing teamsuzie packages may require building them first (`pnpm --filter
"<pkg>..." build` in `../open_teamsuzie`) and may pull in their theme tokens and
infra expectations. That cost is intended — parity with the platform beats a
divergent local copy.

## Working Rules

- Prefer small, focused changes that preserve existing package boundaries.
- Match local patterns before introducing new abstractions.
- Don't reinvent what `open_teamsuzie` already provides (see above).
- Build the workspace packages and reused teamsuzie packages before running an
  app — the apps consume compiled `dist/` output, not source.
- Add tests for behavioral changes.
