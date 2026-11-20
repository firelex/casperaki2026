#!/usr/bin/env bash
# Starts Casperaki's services on datigator, each in its own tmux session. A session that already
# exists is left alone, so running this twice is harmless. Run at boot by the @reboot crontab line
# (see docs/66-deployment.md). Sessions are named exactly (-t =name).
#
#   casperaki-auth   open_teamsuzie platform auth (OIDC issuer, shared-auth), port 16505
#   casperaki-brain  brain: /api + the built web app, port 16500
#
# Configuration and secrets live outside the repos in ~/.config/casperaki (auth/.env, brain.env);
# data in ~/casperaki-data. Postgres for auth is the docker container casperaki-pg (restarts itself).
set -uo pipefail
export PATH=$HOME/.local/bin:$PATH
CONF=$HOME/.config/casperaki
DATA=$HOME/casperaki-data
TS=$HOME/apps/open_teamsuzie
CA=$HOME/apps/casperaki
mkdir -p "$DATA"
start() { # start <session> <command>
  if tmux has-session -t "=$1" 2>/dev/null; then echo "$1: already running"; else tmux new-session -d -s "$1" "$2" && echo "$1: started"; fi
}
docker start casperaki-pg >/dev/null 2>&1 || { echo "casperaki-pg: docker container would not start" >&2; exit 1; }
# The auth service runs from source (tsx): its tsc build does not copy src/migrations into dist/,
# so the built server would skip its migrations (and never create the oidc_models table).
start casperaki-auth "cd $CONF/auth && exec $TS/apps/platform/auth/node_modules/.bin/tsx $TS/apps/platform/auth/src/bootstrap.ts 2>&1 | tee -a $CONF/auth/serve.log"
start casperaki-brain "cd $CA/apps/brain && set -a && . $CONF/brain.env && set +a && exec node_modules/.bin/tsx src/index.ts 2>&1 | tee -a $DATA/brain.log"
