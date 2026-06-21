#!/usr/bin/env bash
# Free Casperaki's dev ports before (re)starting, so a leftover server from a
# previous run doesn't cause EADDRINUSE. Best-effort; never fails the run.
set -u

ports=("${CASPERAKI_PORT:-16400}" "${CASPERAKI_CLIENT_PORT:-16401}")

for port in "${ports[@]}"; do
  pids=""
  if command -v lsof >/dev/null 2>&1; then
    pids=$(lsof -ti tcp:"$port" 2>/dev/null || true)
  elif command -v fuser >/dev/null 2>&1; then
    pids=$(fuser "$port"/tcp 2>/dev/null || true)
  fi
  if [ -n "${pids}" ]; then
    echo "[kill-stray] freeing port $port (pids: $pids)"
    kill -9 ${pids} 2>/dev/null || true
  fi
done

exit 0
