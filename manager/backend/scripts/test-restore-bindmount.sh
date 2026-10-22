#!/bin/sh
# Run src/services/backupRestore.bindmount.test.ts against a REAL bind mount,
# the layout of the manager container (/opt/hytale/data is a mount point),
# inside a throwaway container. Needs Docker; works on any host OS.
#
#   cd manager/backend && sh scripts/test-restore-bindmount.sh
#
# CI runs the same test with `mount --bind` directly (see .github/workflows/ci.yml).
set -eu

BACKEND_DIR=$(cd "$(dirname "$0")/.." && pwd)
DATA_DIR=$(mktemp -d)
trap 'rm -rf "$DATA_DIR"' EXIT
HOST_BACKEND_DIR=$BACKEND_DIR
HOST_DATA_DIR=$DATA_DIR
# Git Bash on Windows: Docker needs Windows paths, and MSYS must not rewrite
# the "-v host:container" arguments (it would turn /src into a Windows path).
if (cd "$BACKEND_DIR" && pwd -W) >/dev/null 2>&1; then
  export MSYS_NO_PATHCONV=1
  HOST_BACKEND_DIR=$(cd "$BACKEND_DIR" && pwd -W)
  HOST_DATA_DIR=$(cd "$DATA_DIR" && pwd -W)
fi
# Same base image as manager/Dockerfile.
IMAGE="${NODE_IMAGE:-node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53}"

docker run --rm \
  -v "$HOST_BACKEND_DIR:/src:ro" \
  -v "$HOST_DATA_DIR:/opt/hytale/data" \
  -e KP_IT_DATA_MOUNT=/opt/hytale/data \
  "$IMAGE" sh -c '
    set -e
    apk add --no-cache unzip python3 make g++ >/dev/null
    mkdir -p /app && cd /app
    cp /src/package.json /src/package-lock.json /src/tsconfig.json /src/vitest.config.ts .
    cp -r /src/src .
    npm ci --no-audit --no-fund >/dev/null
    status=0
    npx vitest run src/services/backupRestore.bindmount.test.ts || status=$?
    # The files belong to root here; remove them before the host cleans up.
    find /opt/hytale/data -mindepth 1 -delete
    exit $status'
