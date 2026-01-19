#!/bin/sh
# ============================================================
# Manager Container Entrypoint
# Switches to manager user (UID 9999, same as hytale container)
# ============================================================

set -e

# UID/GID 9999 = same as hytale container for shared volume access
MANAGER_UID=9999
SHARED_GID=9999

echo "[Manager] Starting as UID $(id -u)..."

# Check if we're running as root (needed for user switching)
if [ "$(id -u)" = "0" ]; then
    # Set umask to ensure new files are group-writable
    umask 002

    echo "[Manager] Switching to manager user (UID: $MANAGER_UID, GID: $SHARED_GID)..."
    exec su-exec $MANAGER_UID:$SHARED_GID "$@"
else
    # Already running as non-root, set umask and run
    umask 002
    exec "$@"
fi
