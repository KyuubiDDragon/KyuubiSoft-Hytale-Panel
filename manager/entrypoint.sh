#!/bin/sh
# ============================================================
# Manager Container Entrypoint
# Fixes permissions on mounted volumes before starting the app
# ============================================================

set -e

# UID/GID of the manager user (must match Dockerfile)
MANAGER_UID=1001
MANAGER_GID=1001

# Directories that need write access
DATA_DIRS="/opt/hytale/data /opt/hytale/server /opt/hytale/backups /opt/hytale/mods /opt/hytale/plugins /opt/hytale/assets"

echo "[Manager] Checking permissions..."

# Check if we're running as root (needed for permission fixing)
if [ "$(id -u)" = "0" ]; then
    # Fix permissions on all mounted directories
    for dir in $DATA_DIRS; do
        if [ -d "$dir" ]; then
            # Check if the directory is writable by manager user
            if ! su-exec $MANAGER_UID:$MANAGER_GID test -w "$dir" 2>/dev/null; then
                echo "[Manager] Fixing permissions for $dir..."
                chown -R $MANAGER_UID:$MANAGER_GID "$dir" 2>/dev/null || {
                    echo "[WARN] Could not fix permissions for $dir - you may need to run:"
                    echo "       sudo chown -R $MANAGER_UID:$MANAGER_GID ${HOST_DATA_PATH:-/opt/hytale}"
                }
            fi
        fi
    done

    echo "[Manager] Switching to manager user..."
    exec su-exec $MANAGER_UID:$MANAGER_GID "$@"
else
    # Already running as non-root, just exec the command
    exec "$@"
fi
