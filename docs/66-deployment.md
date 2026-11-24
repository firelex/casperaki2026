# 66 — Deployment on datigator: login → song → audio, behind the gateway

Status 2026-11-20: the whole flow runs on datigator and has been tested end to end in a browser against the
localhost configuration: sign in → projects → generate → editor → render → play → edit → save & render again →
download WAV. The services now run with the production configuration for `casperaki.com`. They can't be reached
from outside until DNS exists (see "Still to do").

## How a request flows

```
browser ──https──> Cloudflare tunnel "jeffhub-api" (~/.cloudflared/jeffhub-api.yml)
   casperaki.com, www.casperaki.com ──> gateway 127.0.0.1:8793 (gateway sign-in, app "casperaki")
                                          └──> brain 127.0.0.1:16500  (/api + the built web app)
   auth.casperaki.com ──────────────────> auth  127.0.0.1:16505  (OIDC issuer, sign-in page)
```

- **Gateway** (`~/gateway`, firelex/gateway): Casperaki is the app `casperaki`. Its whole site is the host
  `casperaki.com` (`hosts`), forwarded to `upstreams.casperaki`. You go through the gateway sign-in first; admins
  open every app, and other logins need `casperaki` ticked on `/admin`. Only `/healthz` is public. Config backups:
  `~/gateway/gateway.json.bak-2026-11-20-casperaki`, `~/.jeff/gateway-apps.json.bak-2026-11-20-casperaki`.
- **Auth** = `open_teamsuzie/apps/platform/auth` (`@teamsuzie/shared-auth` users, organizations and sessions, plus
  the oidc-provider issuer). The brain is its OIDC client `casperaki-brain`, with the redirect URI
  `https://casperaki.com/api/auth/callback`. Registration is closed: an admin creates accounts with
  `echo -n "$PW" | node scripts/create-user.mjs <email> "<name>" [admin]`. Run that in
  `open_teamsuzie/apps/platform/auth`, with `set -a; . ~/.config/casperaki/auth/.env; set +a` first.
  A demo account `demo@example.com` (normal user, short password set at the owner's request; the script's
  12-character minimum was bypassed by calling `UserService.create` directly) exists for trying the app.
  Postgres is the docker container `casperaki-pg` (127.0.0.1:5452, volume `casperaki-pg-data`, restarts
  itself). Redis is the system Redis (key prefix `casperaki-auth`).
- **Demo sign-in** (`BRAIN_DEMO_LOGIN=1` in `brain.env`, `apps/brain/src/auth/demoAuth.ts`): while the site sits
  behind the gateway, the brain skips OIDC and shows its own login screen (`/sign-in`) with one fixed account,
  `demo@example.com` / `demo123`, printed on the screen as a hint. The demo user is an admin (sound library, pattern
  lab). The session cookie is an HMAC of the user id under `SESSION_SECRET`. The auth service is not used in this
  mode; remove the line from `brain.env` and restart the brain to go back to OIDC.
- **Brain** (`apps/brain`) serves `/api/*` and, because `BRAIN_WEB_DIST_DIR` is set, the built web app with an SPA
  fallback. Its data is in `~/casperaki-data`: `songs.sqlite` (songs + per-user projects), `auth.sqlite` (brain
  sessions), `renders/<songId>/` and `brain.log`.

## Rendering

`POST /api/songs/:id/render` queues a job. Jobs run one at a time (`src/render/renderService.ts`):

1. **lower**: `apps/engine-spike/scripts/emit-brain-roundtrip.mjs` with `BRAIN_SONG_FILE=<stored song>` writes the
   engine envelope (song.json, inst-N.json, asset-manifest.json).
2. **render**: `apps/web/wasm/engine/build/casperaki_render` is the native build of the WASM engine (no Wine, no
   JUCE). It uses the real sample library at `CASPERAKI_SAMPLE_LIBRARY_ROOT` (`/mnt/d/…/datigator-instruments/
   instruments`). `BRAIN_RENDER_MIX=1` (the default) turns on the per-lane mix and the rack FX.
3. **encode**: ffmpeg writes `out.mp3` (for playback); `out.wav` is the download.

A 100–200 s song takes about 20–40 s. Songs are content-addressed, so a render is valid forever for its song id.
Saving an edit gives the song a new id, which needs a new render. A job that was running when the brain restarted
shows as failed ("interrupted"). Press Render again to retry it. Each step's log is in the song's render
directory.

If `casperaki_render` is missing (`build/` is not committed), rebuild it in `apps/web/wasm/engine`:
`cmake -S . -B build && cmake --build build` (that folder's README).

## Live playback in the browser

Play needs no server render. The brain lowers the song (about 1 s, cached per song id in
`BRAIN_PLAYBACK_DIR`) and serves the sample slices it plays as small OGGs (`BRAIN_SAMPLE_CACHE_DIR`;
cut from the library on first use, pre-warmed when a song is opened). The browser's WASM engine
(`apps/web/public/wasm/engine-render.wasm`, built by `apps/web/wasm/engine/build-wasm.sh`; gitignored,
so `deploy.sh` builds it) mixes them in real time in an AudioWorklet. The editor plays the version on
screen, unsaved edits included (`POST /api/playback`). The server render is now only **Export**
(WAV / MP3 downloads).

Live playback is mastered like the export: while the stand-in (+5 dB into NC-17) plays, a worker
renders the song unmastered and analyses it (the matched master of `casperaki_master sergree`), then
the worklet crossfades to the matched master (the status bar says which plays). The Export window's
Mix tab makes its four files (mastered / unmastered, WAV / MP3) in the browser the same way, with
LAME 3.100 compiled to `apps/web/public/wasm/lame.wasm` (`apps/web/wasm/lame/build-lame-wasm.sh`,
gitignored, built by `deploy.sh`). The server render stays for the projects page and the DAW exports.

The live path plays the full mix and effects like the server render (the brain hands the browser
`CASPERAKI_MIX_CONFIG`, i.e. casperaki_engine/config/mix-config.json; required). The WASM mix runs
7.6-11.4x real time. Seeking renders 1.5 s silently first so reverb and delay tails are back.

## Suggestions (admins): pattern lab and Pro-mode mixes

`/suggestions` (header link "Suggestions", also in the account menu; `/patterns` redirects there) has two
tabs.

**Patterns** (the pattern lab): Casperaki-written pattern proposals (`packages/arrangement/data/patterns/proposals/*.json`)
for every instrument: drums, bass, keys, guitar, pads, strings, brass, synths (formats and how to write
them: docs/68). Each can be heard in a full
song with the proposal or with the current library on the same seed, then approved or rejected
(stored in `songs.sqlite`, table `pattern_reviews`). Approved ones reach new songs after:

```sh
cd apps/brain && set -a && . ~/.config/casperaki/brain.env && set +a
node_modules/.bin/tsx scripts/export-approved-patterns.ts   # writes data/patterns/{drums,bass,authored}
```

then commit, push and `deploy.sh`. The reviewer account is `reviewer@casperaki.com` (password in
`~/.config/casperaki/reviewer-password.txt`); admins are listed in `BRAIN_ADMIN_EMAILS`.

**Mix**: what users changed in the track view's **Pro mode**, per genre, next to the standard value
(`GET /api/suggestions/mix`). In the editor's mixer the PRO button makes the faders, the reverb / delay /
chorus sends and every bus plugin's settings (in its device window) editable; changes play at once
(engine `mixer_set_lane_trim` / `_lane_send` / `_bus_param`) and are saved with the project
(`PUT /api/songs/:id/mix`, `projects.mix_overrides`). Reset puts the standard mix back. The saved changes
are applied to the standard `mix-config.json` by one rule (`applyMixOverrides`, song-schema): track
trims and sends as the config's `laneOverrides`, plugin settings in its `rackChains`. Live playback, the
browser export and server renders (`CASPERAKI_MIX_CONFIG` = the song's own config) all use it. A change
many songs of a genre agree on is approved on the Suggestions page: the brain rewrites
`casperaki_engine/config/mix-config.json`, commits it in that repo (message `mix: approve …`, the summary
in the body) and pushes it at once; a failing commit or push fails the approval. The copy in this repo
(`apps/native-engine/config/mix-config.json`) is not updated by approvals.

## Configuration (outside the repos)

| File | What |
|---|---|
| `~/.config/casperaki/auth/.env` | auth service (production: issuer `https://auth.casperaki.com`) |
| `~/.config/casperaki/brain.env` | brain (production: `https://casperaki.com`) ; `BRAIN_ADMIN_EMAILS` lists who may open the sound library |
| `~/.config/casperaki/*.localhost` | the same files for localhost testing (`http://localhost:16500` and `:16505`) |
| `~/.config/casperaki/admin-password.txt` | password of the first admin, `admin@casperaki.com` |
| `~/.config/casperaki/reviewer-password.txt` | password of the pattern-lab reviewer, `reviewer@casperaki.com` |
| `~/.config/casperaki/pg-password`, `brain-client-secret` | Postgres password; OIDC client secret (in both env files) |

To test locally, copy the `.localhost` files over the production ones and restart both services. Then open
http://localhost:16500.

## Start, deploy, restart

- `deploy/datigator/start.sh` starts the tmux sessions `casperaki-auth` and `casperaki-brain` if they are missing.
- `deploy/datigator/deploy.sh [--auth] [--full]`: from a clean checkout (work in progress under `apps/models` is
  allowed), it installs, builds the teamsuzie packages, the casperaki packages, the browser engine and MP3 encoder
  (WASM), the native renderer and the web app, then restarts the brain (and the auth service with `--auth`). A
  step is skipped when its inputs are unchanged since the last deploy (fingerprints in
  `~/.local/state/casperaki-deploy/`; a missing output also rebuilds); `--full` rebuilds everything. Typical
  times: nothing changed 6 s, web only about 30 s, everything about 65 s.
- The auth service runs from source with tsx, on purpose. Its `tsc` build does not copy `src/migrations` into
  `dist/`, so the built server skips its migrations and never creates `oidc_models` (open_teamsuzie bug, below).

## Still to do (needs the owner)

1. **DNS**: put the `casperaki.com` zone in the Cloudflare account, then route the three names to the tunnel:
   `~/bin/cloudflared tunnel route dns jeffhub-api casperaki.com` (and the same for `www.casperaki.com` and
   `auth.casperaki.com`).
2. **Restart the tunnel** so it picks up the new ingress rules. They are already in
   `~/.cloudflared/jeffhub-api.yml` and pass `cloudflared tunnel ingress validate`; the backup is
   `jeffhub-api.yml.bak-casperaki`. Run `tmux kill-session -t =jeff-api-tunnel` and then the `jeff-api-tunnel`
   line of `~/bin/start-services.sh`.
3. **Start at boot**: add `start casperaki "~/apps/casperaki/deploy/datigator/start.sh"`, or the two `start` lines
   from it, to `start-services.sh` in firelex/gateway (on the Mac). Or add a crontab line:
   `@reboot sleep 30 && ~/apps/casperaki/deploy/datigator/start.sh >> ~/casperaki-data/start.log 2>&1`.
4. **Gateway README** (firelex/gateway, on the Mac): add Casperaki to the table of apps.
5. Optional: if Casperaki should not need the gateway sign-in in front of its own sign-in, set the app's
   `public_paths` to `["/"]` in `gateway.json`. Casperaki's own OIDC login then guards it alone.

## Known issues found on the way

- open_teamsuzie `apps/platform/auth`: `build` copies only `src/oidc/views`, not `src/migrations`, so `node
  dist/index.js` runs no migrations. Fix: also copy `src/migrations` to `dist/migrations`.
- open_teamsuzie `packages/ui`: there is no `"sideEffects": false`, so importing one `Button` bundles the whole
  package (mermaid included). The web app's main chunk is 1.35 MB (414 kB gzip).
- (fixed 2026-11-21) `apps/brain/test/catalog.spec.ts` counted catalog totals against the xlsx-only snapshot; now the effective (xlsx ∪ disk) one.
  This predates this work.
