#!/usr/bin/env bash
# Deploy Casperaki on datigator from what is committed: rebuild the shared packages, the web app,
# then restart the brain (and the auth service with --auth). Run from anywhere on datigator.
set -euo pipefail
CA=$HOME/apps/casperaki
TS=$HOME/apps/open_teamsuzie
cd "$CA"
if [ -n "$(git status --porcelain -- apps packages ':(exclude,glob)**/~$*' ':(exclude,glob)**/*.tsbuildinfo')" ]; then echo "uncommitted changes under apps/ or packages/; commit first" >&2; exit 1; fi
pnpm install --frozen-lockfile
(cd "$TS" && pnpm --filter "@teamsuzie/ui..." --filter "@teamsuzie/theme..." --filter "@teamsuzie/auth..." build)
pnpm -r --filter "./packages/*" build
# The browser engine (public/wasm/engine-render.wasm, gitignored) and the native renderer the
# server's Export uses are built from apps/web/wasm/engine; emsdk lives in ~/emsdk. LAME
# (public/wasm/lame.wasm, the browser's MP3 encoder, gitignored) is built from its pinned tarball.
apps/web/wasm/engine/build-wasm.sh
apps/web/wasm/lame/build-lame-wasm.sh
cmake --build apps/web/wasm/engine/build
pnpm -C apps/web exec vite build
tmux kill-session -t =casperaki-brain 2>/dev/null || true
if [ "${1:-}" = "--auth" ]; then tmux kill-session -t =casperaki-auth 2>/dev/null || true; fi
"$CA/deploy/datigator/start.sh"
for i in $(seq 1 30); do curl -sf http://127.0.0.1:16500/healthz >/dev/null && break; sleep 1; done
curl -sf http://127.0.0.1:16500/healthz && echo
curl -sf http://127.0.0.1:16505/api/health && echo
