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
    # Always run chown to ensure both directories AND files inside are owned correctly
    for dir in $DATA_DIRS; do
        if [ -d "$dir" ]; then
            echo "[Manager] Fixing permissions for $dir..."
            echo "[Manager] Before chown: $(ls -la $dir 2>&1 | head -5)"
            if ! chown -R $MANAGER_UID:$MANAGER_GID "$dir" 2>&1; then
                echo "[WARN] Could not fix permissions for $dir - you may need to run:"
                echo "       sudo chown -R $MANAGER_UID:$MANAGER_GID ${HOST_DATA_PATH:-/opt/hytale}"
            fi
            echo "[Manager] After chown: $(ls -la $dir 2>&1 | head -5)"
            # Specific check for users.json
            if [ -f "$dir/users.json" ]; then
                echo "[Manager] users.json: $(ls -la $dir/users.json 2>&1)"
            fi
        fi
    done

    # Final check - list all files in data dir
    echo "[Manager] All files in /opt/hytale/data:"
    ls -la /opt/hytale/data/ 2>&1

    echo "[Manager] Switching to manager user (UID: $MANAGER_UID, GID: $MANAGER_GID)..."
    exec su-exec $MANAGER_UID:$MANAGER_GID "$@"
else
    # Already running as non-root, just exec the command
    exec "$@"
fi
