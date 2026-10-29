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

    # Add docker socket group to manager user for container management
    if [ -S /var/run/docker.sock ]; then
        DOCKER_GID=$(stat -c '%g' /var/run/docker.sock)
        echo "[Manager] Docker socket GID: $DOCKER_GID"

        # The manager joins a group of its own that carries the socket's GID,
        # never a group of the image that happens to have it (-o allows the
        # duplicate GID, e.g. 0 = root on Docker Desktop). Uses groupadd,
        # groupmod and usermod from the shadow package.
        SOCKET_GROUP=dockersock
        if getent group "$SOCKET_GROUP" >/dev/null 2>&1; then
            groupmod -o -g "$DOCKER_GID" "$SOCKET_GROUP" 2>/dev/null || true
        else
            groupadd -o -g "$DOCKER_GID" "$SOCKET_GROUP" 2>/dev/null || true
        fi
        if [ "$(getent group "$SOCKET_GROUP" | cut -d: -f3)" = "$DOCKER_GID" ] &&
            usermod -aG "$SOCKET_GROUP" manager 2>/dev/null; then
            echo "[Manager] Docker socket access through group $SOCKET_GROUP (GID: $DOCKER_GID)"
            if [ "$DOCKER_GID" = "0" ]; then
                echo "[Manager] NOTE: the Docker socket belongs to GID 0 (root group, e.g. Docker Desktop)."
                echo "[Manager]       The panel process gets that group to reach it; it stays UID $MANAGER_UID"
                echo "[Manager]       without capabilities. To avoid it, use the docker-socket-proxy"
                echo "[Manager]       service from docker-compose.yml (DOCKER_HOST=tcp://docker-socket-proxy:2375)."
            fi
        else
            echo "[Manager] WARNING: could not give the manager access to the Docker socket (GID: $DOCKER_GID)"
        fi
    fi

    # Folder of the additional servers (docker-compose.yml mounts
    # ${HOST_DATA_PATH}/instances here). Docker creates a missing bind source
    # as root, and the manager could not create server folders in it. Only
    # that case is fixed, and only the folder itself, never its contents.
    INSTANCES_DIR="${INSTANCES_PATH:-/opt/hytale-instances}"
    if [ -d "$INSTANCES_DIR" ] && [ ! -L "$INSTANCES_DIR" ] && [ "$(stat -c '%u' "$INSTANCES_DIR")" = "0" ]; then
        if chown "$MANAGER_UID:$SHARED_GID" "$INSTANCES_DIR" 2>/dev/null; then
            echo "[Manager] $INSTANCES_DIR now belongs to UID $MANAGER_UID"
        else
            echo "[Manager] WARNING: cannot change the owner of $INSTANCES_DIR (run: sudo chown 9999:9999 <HOST_DATA_PATH>/instances)"
        fi
    fi

    echo "[Manager] Switching to manager user (UID: $MANAGER_UID)..."
    # gosu properly handles supplementary groups
    exec gosu manager "$@"
else
    # Already running as non-root, set umask and run
    umask 002
    exec "$@"
fi
