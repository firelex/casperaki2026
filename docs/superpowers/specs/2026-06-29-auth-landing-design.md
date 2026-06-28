# Auth + Landing Page — Design

Date: 2026-06-29
Status: Approved (pending spec review)

## Goal

Put the casperaki workbench behind **real authentication**, reusing the
`open_teamsuzie` platform instead of building bespoke auth. Unauthenticated
visitors see a public landing page; signed-in users reach Projects/Editor.

## Decisions (locked during brainstorming)

| Decision | Choice |
| --- | --- |
| Auth type | Real authentication (not a visual mock) |
| Architecture | **OIDC client** — mirror `apps/suzie-it-department`; do **not** embed `shared-auth` in the brain |
| Identity provider | The shared `open_teamsuzie/apps/platform/auth` OIDC provider |
| Tenancy | Users only. A single default org is created provider-side; no org UI in casperaki |
| Sign-in methods | Email + password and Google — both handled by the provider's login UI |
| Landing/login UX | Keep the existing bespoke animated casperaki landing; wire its "Log in" to the real OIDC redirect. New app chrome from `@teamsuzie/ui` |

Non-goals: org/tenant UI, invites, Apple sign-in, embedding sequelize/Postgres/
Redis into the brain, migrating the brain off Express 4.

## Architecture

```
Browser ──▶ apps/web (Vite :5173)
              │  /api proxied to brain
              ▼
          apps/brain (Express 4 + sqlite, :16500)   ── OIDC client ──▶  open_teamsuzie/apps/platform/auth
              - local sessions table (its sqlite)                         (OIDC provider; owns users,
              - OidcClient → provider                                      passwords, Google, login UI)
              - attachSession / requireSession                            backed by Postgres + Redis
              - /api/auth/{me,login,callback,logout}                      (docker-compose in open_teamsuzie)
```

The heavy infra (Postgres, Redis, Express 5, sequelize, OAuth) lives **only** in
the shared provider. The brain stays Express 4 + better-sqlite3 and gains a thin
OIDC-client layer ported almost file-for-file from `suzie-it-department`.

## Components

### 1. Shared OIDC provider (open_teamsuzie/apps/platform/auth)
- Runs with its `docker/docker-compose.yml` (Postgres + Redis).
- Register a `casperaki` OIDC client: redirect URI
  `http://localhost:16500/api/auth/callback`.
- Configure Google OAuth credentials once, provider-side.
- A single default org satisfies the multi-tenant model; no casperaki UI for it.
- **Owned by the platform** — casperaki only consumes it. This repo adds no code
  here beyond client registration/config.

### 2. Brain OIDC-client layer (apps/brain)
Ported from `suzie-it-department/src/server/auth/`:
- `src/server/auth/SessionBundleRepo.ts` — sessions persisted in the brain's
  existing sqlite store, signed with `SESSION_SECRET`. Adds a `sessions` table
  via the store's migration path. Hourly `purgeExpired()` sweep.
- `src/server/auth/OidcClient.ts` — authorization-code (PKCE) flow against the
  provider; token exchange + userinfo.
- `src/server/auth/tokenRefresh.ts` — refresh expiring provider tokens.
- `src/server/auth/middleware.ts` — `attachSession` (runs on every request,
  attaches `req.user` when a valid cookie is present, **never rejects**) and
  `requireSession` (401 gate).
- `src/server/routes/auth.ts` — `/api/auth/{me,login,callback,logout}`.

Wiring in `apps/brain/src/bootstrap.ts` (mirrors suzie-it-department ordering):
```
app.use(attachSession(...))                 // always; sets req.user if valid
app.get('/healthz', ...)                    // stays public
app.use('/api/auth', authRouter(...))       // BEFORE the gate
app.use('/api', requireSession())           // gate everything else
app.use(createSongsRouter(...))             // now behind the gate
app.use(createRendersRouter(...))
app.use(createCatalogRouter())
```
Config additions (`apps/brain/src/config.ts`): `SESSION_SECRET` (required in
production, random dev fallback), `OIDC_ISSUER`, `OIDC_CLIENT_ID`,
`OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI`.

### 3. Web auth seam + route split (apps/web)
- Add `@teamsuzie/ui` and `@teamsuzie/theme` as `link:` deps; add a
  `deps:build` script (build them once, like suzie-it-department).
- Port `src/web/auth/AuthContext.tsx` → `AuthProvider`/`useAuth`: `me()` on
  mount, `signIn()` redirects to `/api/auth/login?returnTo=…`, `signOut()`
  clears + bounces to `/`.
- `src/api/client.ts` gains `auth.{me,loginUrl,logout}` helpers and treats 401
  as the normal "not signed in" path (no console noise).
- Route split in `App.tsx`:
  - **Public:** `/` (landing). WASM dev pages may stay public/dev-only.
  - **Gated:** Projects, `/editor/*`, `/catalog` — wrapped so unauthenticated
    users are sent to the landing. While `useAuth().isLoading`, render nothing
    (or a spinner) to avoid a flash of the gated UI.

### 4. Landing + chrome
- Repurpose the existing bespoke `apps/web/src/pages/LoginPage.tsx` as the
  public landing at `/`. Its "Log in" / "Use phone or email" / "Continue with
  Google" buttons call `signIn()` (real OIDC redirect) instead of faking
  navigation. The actual credential entry happens on the provider's login UI,
  so the in-app email/password fields are **removed** — the right panel
  collapses to "Sign in" / "Continue with Google" CTAs that both call
  `signIn()` (Google is just the provider login with the Google option). No
  dead form posting nowhere.
- New chrome introduced for signed-in users (top-bar account menu, sign-out)
  is built from `@teamsuzie/ui` primitives, not hand-rolled.

## Data flow (sign-in)
1. Visitor hits `/` → landing (brain `me()` returned 401 → `user = null`).
2. Clicks "Log in" → browser navigates to `/api/auth/login` → brain redirects to
   the provider's authorize endpoint (PKCE).
3. User authenticates on the provider (email/password or Google).
4. Provider redirects to `/api/auth/callback` → brain exchanges the code, creates
   a local session (`SessionBundleRepo`), sets the signed cookie, redirects to
   `returnTo`.
5. Web `AuthProvider` re-fetches `me()` → `user` populated → gated routes render.

## Error handling
- `me()` 401 → unauthenticated; render landing. Non-401 → log, treat as
  signed-out.
- Callback failures (bad code, provider down) → redirect to `/` with an error
  banner; never leave a half-open session.
- Missing `SESSION_SECRET` in production → boot fails fast (dev uses a random
  per-process fallback, matching suzie-it-department).
- Provider unreachable at startup → brain still boots; `/api/auth/login` surfaces
  a clear error rather than crashing.

## Testing
- **Brain unit:** `attachSession` attaches/skips correctly; `requireSession`
  401s without a cookie; `SessionBundleRepo` create/lookup/expiry/purge;
  `/api/auth/me` shape. Provider calls mocked.
- **Brain integration:** gated route returns 401 unauthenticated, 200 with a
  seeded session cookie; `/healthz` and `/api/auth/*` reachable unauthenticated.
- **Web:** `AuthProvider` renders landing on 401 and gated content once `me()`
  resolves; gated route redirects when `user` is null.
- Manual: full round-trip against a locally running provider (email + Google).

## Rollout / prerequisites
1. Stand up the provider (docker-compose PG+Redis; register casperaki client;
   Google creds). Document in `apps/brain/.env.example` + README.
2. Build `@teamsuzie/ui` + `@teamsuzie/theme` (and `shared-auth` transitively if
   the provider isn't already built) before running.
3. Without the provider running, the brain boots but sign-in fails — acceptable
   for pure UI work on the landing.

## Open questions
- Exact provider base URL/port and client-registration mechanism (env vs a seed
  script) — confirm against the running provider during implementation.
- Whether the dev-only `/wasm-*` pages stay public (proposed: yes, dev-only).
