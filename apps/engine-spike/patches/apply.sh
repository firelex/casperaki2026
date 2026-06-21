#!/usr/bin/env bash
# Apply the engine-spike patches against a fresh checkout of casperaki_engine.
# Idempotent: re-running on an already-patched tree is a no-op (skips with a
# warning). Run from anywhere; resolves the engine path relative to this
# script's location.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
ENGINE_REPO="${CASPERAKI_ENGINE_REPO:-${SCRIPT_DIR}/../../../../casperaki_engine}"

if [[ ! -d "${ENGINE_REPO}" ]]; then
  echo "engine repo not found at ${ENGINE_REPO}" >&2
  echo "set CASPERAKI_ENGINE_REPO to override" >&2
  exit 1
fi

cd "${ENGINE_REPO}"

for patch in "${SCRIPT_DIR}"/*.patch; do
  name="$(basename "${patch}")"
  if git apply --check "${patch}" 2>/dev/null; then
    echo "[apply] applying ${name}"
    git apply "${patch}"
  elif git apply --reverse --check "${patch}" 2>/dev/null; then
    echo "[apply] ${name} already applied, skipping"
  else
    echo "[apply] ${name} does not apply cleanly and is not already applied — aborting" >&2
    exit 1
  fi
done

echo "[apply] all patches applied to ${ENGINE_REPO}"
