#!/usr/bin/env bash
# Starts Casperaki's services on datigator, each in its own tmux session. A session that already
# exists is left alone, so running this twice is harmless. Run at boot by the @reboot crontab line
# (see docs/66-deployment.md). Sessions are named exactly (-t =name).
#
#   casperaki-auth   open_teamsuzie platform auth (OIDC issuer, shared-auth), port 16505
#   casperaki-brain  brain: /api + the built web app, port 16500
#   svc-hum          hum transcription model service (hum to song), port 16510
#   svc-amt          melody completion model service (hum to song), port 16511
#   svc-vocals       sing and transcribe model service (YuE2, SoulX-Singer, ChordNet), port 16514
#   svc-artwork      song artwork image service (segmind/small-sd), port 16513
#
# At boot the Windows task "Start WSL at boot" starts WSL; systemd starts cron, whose @reboot line runs this
# (crontab: @reboot $HOME/apps/casperaki/deploy/datigator/start.sh >> $HOME/casperaki-data/boot.log 2>&1).
# The Cloudflare tunnel and gateway that serve casperaki.com are started by ~/bin/start-services.sh (firelex/gateway).
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
echo "=== $(date '+%F %T') casperaki start"
# At boot Docker may still be starting: wait for it (5 minutes at most), then fail loudly.
timeout 300 bash -c 'until docker info >/dev/null 2>&1; do sleep 3; done' || { echo "docker is not running after 5 minutes" >&2; exit 1; }
docker start casperaki-pg >/dev/null 2>&1 || { echo "casperaki-pg: docker container would not start" >&2; exit 1; }
# The auth service runs from source (tsx): its tsc build does not copy src/migrations into dist/,
# so the built server would skip its migrations (and never create the oidc_models table).
start casperaki-auth "cd $CONF/auth && exec $TS/apps/platform/auth/node_modules/.bin/tsx $TS/apps/platform/auth/src/bootstrap.ts 2>&1 | tee -a $CONF/auth/serve.log"
start casperaki-brain "cd $CA/apps/brain && set -a && . $CONF/brain.env && set +a && exec node_modules/.bin/tsx src/index.ts 2>&1 | tee -a $DATA/brain.log"
# Model services for hum to song (apps/models/services/_serving harness; GPU).
SERVING=$CA/apps/models/services/_serving
start svc-hum "cd $SERVING && exec python3 harness.py --adapter hum --port 16510 2>&1 | tee -a run/svc-hum.log"
start svc-amt "cd $SERVING && exec python3 harness.py --adapter amt --port 16511 2>&1 | tee -a run/svc-amt.log"
# Song artwork (apps/brain/src/artwork; brain.env ARTWORK_SERVICE_URL + BRAIN_ARTWORK_DIR).
start svc-artwork "cd $SERVING && exec python3 harness.py --adapter small-sd --port 16513 --models-dir /mnt/d/casperaki-models 2>&1 | tee -a run/svc-artwork.log"
# Sing and transcribe (vocals adapter; own venv at apps/models/services/vocals/.venv).
start svc-vocals "cd $SERVING && exec python3 harness.py --adapter vocals --port 16514 2>&1 | tee -a run/svc-vocals.log"
