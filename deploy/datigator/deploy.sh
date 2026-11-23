#!/usr/bin/env bash
# Deploy Casperaki on datigator from what is committed: rebuild the shared packages, the web app,
# then restart the brain (and the auth service with --auth). Run from anywhere on datigator.
#
#   deploy.sh [--auth] [--full]
#
# Slow steps are skipped when their inputs have not changed since the last successful deploy: each
# step's inputs (git tree hashes plus any uncommitted changes and untracked files in its paths) are
# fingerprinted and the fingerprint is kept in ~/.local/state/casperaki-deploy/<step>. A step also
# runs when its outputs are missing. --full ignores the fingerprints and rebuilds everything.
set -euo pipefail
CA=$HOME/apps/casperaki
TS=$HOME/apps/open_teamsuzie
STATE=$HOME/.local/state/casperaki-deploy
AUTH=0
FULL=0
for arg in "$@"; do
  case "$arg" in
    --auth) AUTH=1 ;;
    --full) FULL=1 ;;
    *) echo "unknown argument: $arg (use --auth, --full)" >&2; exit 2 ;;
  esac
done
mkdir -p "$STATE"
cd "$CA"
# apps/models (model training) is not part of the site, so work in progress there does not block a deploy.
if [ -n "$(git status --porcelain -- apps packages ':(exclude)apps/models' ':(exclude,glob)**/~$*' ':(exclude,glob)**/*.tsbuildinfo')" ]; then echo "uncommitted changes under apps/ or packages/; commit first" >&2; exit 1; fi

# Fingerprint of paths in a repo: committed trees + uncommitted diff + untracked files' contents.
fingerprint() {
  local repo=$1; shift
  {
    git -C "$repo" ls-tree HEAD -- "$@"
    git -C "$repo" diff HEAD -- "$@"
    git -C "$repo" ls-files -o --exclude-standard -z -- "$@" | (cd "$repo" && xargs -0r sha1sum)
  } | sha1sum | cut -d' ' -f1
}

# step <name> <fingerprint> <required output…> -- <command…>
step() {
  local name=$1 fp=$2; shift 2
  local outputs=()
  while [ "$1" != "--" ]; do outputs+=("$1"); shift; done
  shift
  local missing=0
  for o in "${outputs[@]}"; do [ -e "$o" ] || missing=1; done
  if [ "$FULL" = 0 ] && [ "$missing" = 0 ] && [ "$(cat "$STATE/$name" 2>/dev/null)" = "$fp" ]; then
    echo "== $name: unchanged, skipped"
    return
  fi
  echo "== $name"
  local t0=$SECONDS
  "$@"
  echo "$fp" > "$STATE/$name"
  echo "== $name: $((SECONDS - t0)) s"
}

T0=$SECONDS
pnpm install --frozen-lockfile

TS_FP=$(fingerprint "$TS" packages pnpm-lock.yaml package.json)
step teamsuzie "$TS_FP" "$TS/packages/ui/dist" -- \
  bash -c "cd '$TS' && pnpm --filter '@teamsuzie/ui...' --filter '@teamsuzie/theme...' --filter '@teamsuzie/auth...' build"

step packages "$(fingerprint "$CA" packages pnpm-lock.yaml)-$TS_FP" "$CA/packages/arrangement/dist" -- \
  pnpm -r --filter "./packages/*" build

# The browser engine (public/wasm/engine-render.wasm, gitignored) and the native renderer the
# server's Export uses are built from apps/web/wasm/engine; emsdk lives in ~/emsdk. LAME
# (public/wasm/lame.wasm, the browser's MP3 encoder, gitignored) is built from its pinned tarball.
step wasm-engine "$(fingerprint "$CA" apps/web/wasm/engine)" \
  apps/web/public/wasm/engine-render.wasm apps/web/public/wasm/engine-resolve.js -- \
  apps/web/wasm/engine/build-wasm.sh
step wasm-lame "$(fingerprint "$CA" apps/web/wasm/lame)" apps/web/public/wasm/lame.wasm -- \
  apps/web/wasm/lame/build-lame-wasm.sh
# cmake is incremental on its own.
echo "== native engine"; cmake --build apps/web/wasm/engine/build
step web "$(fingerprint "$CA" apps/web packages pnpm-lock.yaml)-$TS_FP-$(cat "$STATE/wasm-engine")-$(cat "$STATE/wasm-lame")" \
  apps/web/dist/index.html -- \
  pnpm -C apps/web exec vite build

tmux kill-session -t =casperaki-brain 2>/dev/null || true
if [ "$AUTH" = 1 ]; then tmux kill-session -t =casperaki-auth 2>/dev/null || true; fi
"$CA/deploy/datigator/start.sh"
for i in $(seq 1 30); do curl -sf http://127.0.0.1:16500/healthz >/dev/null && break; sleep 1; done
curl -sf http://127.0.0.1:16500/healthz && echo
curl -sf http://127.0.0.1:16505/api/health && echo
echo "deployed in $((SECONDS - T0)) s"
