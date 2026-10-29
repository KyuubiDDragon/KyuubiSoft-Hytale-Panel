#!/bin/bash
# ============================================================
# Hytale Server - Entrypoint
# ============================================================
# pipefail catches failures inside pipelines (e.g. wget | unzip).
# -e is intentionally omitted: the download retry loop relies on capturing
# non-zero exit codes from the downloader. -u is omitted because several
# optional env vars (SERVER_JAR_URL, ASSETS_URL, USE_HYTALE_DOWNLOADER,
# AUTO_UPDATE, HYTALE_PATCHLINE) may be unset.
set -o pipefail

# ============================================================
# Stop signals
# ============================================================
# Until it hands over to start-server.sh (exec at the end) this script is
# PID 1. The kernel only delivers signals to PID 1 that it has a handler for,
# and bash runs a trap only between foreground commands, so `docker stop`
# during a download, the login wait or the wait for server files used to run
# into the full grace period before Docker killed the container. Long steps
# therefore run in the background (run_interruptible) and the trap fires at
# once: it stops that step, removes a download it cut short and exits. No
# server runs yet, so there is nothing to save. While the downloaded files
# are unpacked and moved into place (CRITICAL=1) a stop waits until that is
# done, so the server folder never holds half of an update. exec resets the
# trap; start-server.sh installs its own first thing.
CHILD_PID=""
PARTIAL_DOWNLOAD=""
CRITICAL=0
STOP_PENDING=0
on_stop_signal() {
    if [ "$CRITICAL" = 1 ]; then
        STOP_PENDING=1
        return
    fi
    trap '' TERM INT
    echo "[INFO] Stop signal received before the server was started - exiting"
    if [ -n "$CHILD_PID" ]; then
        # The container has no CAP_KILL: root cannot signal a step that runs
        # as the hytale user, so that one is signalled as hytale.
        kill -TERM "$CHILD_PID" 2>/dev/null || gosu hytale kill -TERM "$CHILD_PID" 2>/dev/null
        wait "$CHILD_PID" 2>/dev/null
    fi
    if [ -n "$PARTIAL_DOWNLOAD" ] && [ -e "$PARTIAL_DOWNLOAD" ]; then
        rm -f -- "$PARTIAL_DOWNLOAD" && echo "[INFO] Removed the unfinished download ${PARTIAL_DOWNLOAD}"
    fi
    [ -n "$DOWNLOADER_OUT" ] && rm -f -- "$DOWNLOADER_OUT"
    exit 143
}
trap on_stop_signal TERM INT

# Ends a CRITICAL section; a stop that came in meanwhile is handled now.
end_critical() {
    CRITICAL=0
    [ "$STOP_PENDING" = 1 ] && on_stop_signal
}

# run_interruptible <command> [args...]: runs the command in the background and
# waits for it, so a stop signal is handled while it runs. Keeps the console
# as stdin (a background job would get /dev/null) and returns its status.
run_interruptible() {
    local rc
    "$@" <&0 &
    CHILD_PID=$!
    wait "$CHILD_PID"
    rc=$?
    CHILD_PID=""
    return "$rc"
}

# ============================================================
# Set timezone at runtime from TZ environment variable
# ============================================================
if [ -n "$TZ" ] && [ -f "/usr/share/zoneinfo/$TZ" ]; then
    ln -snf "/usr/share/zoneinfo/$TZ" /etc/localtime
    echo "$TZ" > /etc/timezone
    echo "[INFO] Timezone set to: $TZ"
else
    echo "[WARN] Invalid or missing TZ variable, using default timezone"
fi

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║       Hytale Dedicated Server - Docker Container         ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║  Java:     $(java -version 2>&1 | head -1 | cut -d'"' -f2)                                   ║"
echo "║  RAM:      ${JAVA_MIN_RAM} - ${JAVA_MAX_RAM}                                ║"
echo "║  Port:     ${SERVER_PORT}/udp                                  ║"
echo "║  Timezone: ${TZ}                                  ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# ============================================================
# Fix permissions
# ============================================================
echo "[INFO] Setting up directories..."
# Set umask 002 so all new files are group-writable (for manager container access)
umask 002
# Native updater (staging/ + backup/) and native world backups. Both are
# bind-mounted from the host and may be created as root by Docker on first run.
mkdir -p /opt/hytale/updater /opt/hytale/backups/native
# Older compose files mounted the updater at server/updater, where the server
# never looked; drop the empty mount point that left behind.
rmdir /opt/hytale/server/updater 2>/dev/null || true
# Directories the server writes into. Created here, before the ownership pass
# below, so they never stay root-owned.
mkdir -p /opt/hytale/data/worlds /opt/hytale/plugins /opt/hytale/mods /opt/hytale/auth
# The prefabs volume is bind-mounted at /opt/hytale/prefabs, but the server
# looks for them under server/prefabs. Symlink it so the mount is actually used
# (no-op when the volume isn't mounted).
if [ -d /opt/hytale/prefabs ]; then
    ln -snf /opt/hytale/prefabs /opt/hytale/server/prefabs
fi

# Give the data volumes to the hytale user, touching only entries that are not
# already hytale:hytale. A blanket `chown -R` rewrites the inode of every world
# and backup file on each start, which is slow on big worlds and makes
# incremental backup tools rescan everything. Symlinks are skipped (their owner
# does not matter) and never followed. The image's own scripts are left
# root-owned on purpose: they run as root, so the server user must not be able
# to edit them.
# FIX_OWNERSHIP=false skips the pass (e.g. NFS with root_squash, where root
# cannot chown and the host already sets the right owner).
fix_ownership() {
    if [ "${FIX_OWNERSHIP:-true}" = "false" ]; then
        echo "[INFO] FIX_OWNERSHIP=false - skipping ownership repair"
        return 0
    fi
    local dirs=() dir fixed
    for dir in /opt/hytale/server /opt/hytale/data /opt/hytale/backups \
               /opt/hytale/plugins /opt/hytale/mods /opt/hytale/prefabs \
               /opt/hytale/downloader /opt/hytale/auth /opt/hytale/updater; do
        [ -d "$dir" ] && dirs+=("$dir")
    done
    # -h as well: should an entry be swapped for a symlink after find saw it,
    # chown still changes the link, never its target.
    if ! fixed=$(find "${dirs[@]}" ! -type l \( ! -user hytale -o ! -group hytale \) \
            -print -exec chown -h hytale:hytale {} + | wc -l); then
        echo "[WARN] Ownership repair hit errors (see above); the server may lack write access"
    elif [ "$fixed" -gt 0 ]; then
        echo "[INFO] Fixed ownership of ${fixed} entries"
    fi
}
fix_ownership

# The panel compares these two files to tell whether it sees the updater
# folder this container uses: a container started from an older compose file
# keeps its staged updates in a private volume the panel cannot see. Written
# as the hytale user (both folders belong to the server); the server copy
# only exists together with the updater copy.
write_updater_mount_marker() {
    local id
    id=$(cat /proc/sys/kernel/random/uuid) || return 0
    # shellcheck disable=SC2016
    if ! gosu hytale sh -c 'printf "%s\n" "$1" > "$2.tmp" && mv -f "$2.tmp" "$2" \
            && printf "%s\n" "$1" > "$3.tmp" && mv -f "$3.tmp" "$3"' \
            sh "$id" /opt/hytale/updater/.updater-mount-id /opt/hytale/server/.updater-mount-id; then
        gosu hytale rm -f /opt/hytale/server/.updater-mount-id
        echo "[WARN] Could not write the updater mount marker; the panel cannot check the updater mount"
    fi
}
write_updater_mount_marker

# ============================================================
# Auth credential encryption key
# ============================================================
# The server keeps its OAuth tokens encrypted in server/auth.enc. The key comes
# from a passphrase file in the auth volume (HYTALE_AUTH_KEY_FILE), generated
# once. Older versions of this image keyed auth.enc to a generated machine-id
# kept in data/ (the world folder), so it ended up in every world backup. The
# server still tries the machine-id when the passphrase does not decrypt an
# existing auth.enc and then re-encrypts it with the passphrase, so existing
# logins survive the switch. The machine-id therefore stays, now in the auth
# volume, also giving the server a stable hardware id.
# An operator-supplied HYTALE_AUTH_KEY_FILE or HYTALE_AUTH_KEY is used as is.
# Files in the data and auth volumes are written and read as the hytale user:
# that user controls those directories, and root following a link planted
# there could overwrite or leak any file in the container.
AUTH_DIR="/opt/hytale/auth"
MACHINE_ID_FILE="${AUTH_DIR}/.machine-id"
LEGACY_MACHINE_ID_FILE="/opt/hytale/data/.machine-id"
AUTH_KEY_FILE="${AUTH_DIR}/auth.passphrase"

# as_hytale <script> [args...]: run a small sh script as the hytale user. The
# script is single-quoted at the call sites on purpose: $1, $2 are its own
# arguments (hence the SC2016 exceptions below).
as_hytale() {
    local script="$1"
    shift
    gosu hytale sh -c "umask 077 && ${script}" sh "$@"
}

# shellcheck disable=SC2016
if [ -f "$LEGACY_MACHINE_ID_FILE" ]; then
    if [ ! -s "$MACHINE_ID_FILE" ]; then
        # Copied via a temp file and then removed rather than moved: the two
        # are separate volumes, and a half-copied id must never be left behind.
        if as_hytale 'cp "$1" "$2.tmp" && mv -f "$2.tmp" "$2" && rm -f "$1"' \
            "$LEGACY_MACHINE_ID_FILE" "$MACHINE_ID_FILE"; then
            echo "[INFO] Moved machine-id from the world folder to the auth volume"
        else
            echo "[WARN] Could not move ${LEGACY_MACHINE_ID_FILE}; using it in place"
            MACHINE_ID_FILE="$LEGACY_MACHINE_ID_FILE"
        fi
    elif as_hytale 'cmp -s "$1" "$2"' "$LEGACY_MACHINE_ID_FILE" "$MACHINE_ID_FILE"; then
        # A restored world backup brought the old copy back.
        as_hytale 'rm -f "$1"' "$LEGACY_MACHINE_ID_FILE"
    else
        echo "[WARN] ${LEGACY_MACHINE_ID_FILE} differs from ${MACHINE_ID_FILE}; using the auth volume copy. Delete the world-folder copy once you no longer need it."
    fi
fi

# Only a missing or empty file is generated: an existing machine-id may be the
# key of an auth.enc that has not been migrated yet.
# shellcheck disable=SC2016
if [ ! -s "$MACHINE_ID_FILE" ]; then
    echo "[INFO] Generating persistent machine-id..."
    as_hytale 'tr -d "-" < /proc/sys/kernel/random/uuid > "$1.tmp" && mv -f "$1.tmp" "$1"' "$MACHINE_ID_FILE"
fi
# The server reads /etc/machine-id for its hardware id.
if machine_id=$(gosu hytale cat "$MACHINE_ID_FILE") && [ -n "$machine_id" ] \
    && printf '%s\n' "$machine_id" > /etc/machine-id && chmod 444 /etc/machine-id; then
    echo "[INFO] Persistent machine-id configured"
else
    echo "[WARN] Could not install /etc/machine-id; logins saved before the passphrase switch cannot be migrated"
fi

# shellcheck disable=SC2016
if [ -n "${HYTALE_AUTH_KEY_FILE:-}" ] || [ -n "${HYTALE_AUTH_KEY:-}" ]; then
    echo "[INFO] Using the auth encryption key from HYTALE_AUTH_KEY_FILE / HYTALE_AUTH_KEY"
    if [ -n "${HYTALE_AUTH_KEY_FILE:-}" ] && ! gosu hytale test -s "$HYTALE_AUTH_KEY_FILE"; then
        echo "[ERROR] HYTALE_AUTH_KEY_FILE=${HYTALE_AUTH_KEY_FILE} is missing, empty or not readable by uid 9999; the server will refuse to start"
    fi
else
    if [ ! -s "$AUTH_KEY_FILE" ]; then
        echo "[INFO] Generating auth encryption passphrase..."
        # Via a temp file: a half-written or empty key file makes the server abort.
        as_hytale 'head -c 32 /dev/urandom | od -An -tx1 | tr -d " \n" > "$1.tmp" && mv -f "$1.tmp" "$1"' \
            "$AUTH_KEY_FILE" || as_hytale 'rm -f "$1.tmp"' "$AUTH_KEY_FILE"
    fi
    if [ -s "$AUTH_KEY_FILE" ]; then
        # Exported even if something is wrong with the file: the server then
        # stops with a clear error instead of silently writing auth.enc with a
        # different key.
        [ "$(stat -c %a "$AUTH_KEY_FILE")" = "600" ] || gosu hytale chmod 600 "$AUTH_KEY_FILE"
        gosu hytale test -r "$AUTH_KEY_FILE" \
            || echo "[ERROR] ${AUTH_KEY_FILE} is not readable by uid 9999; the server will refuse to start"
        export HYTALE_AUTH_KEY_FILE="$AUTH_KEY_FILE"
        echo "[INFO] Auth credentials are encrypted with ${AUTH_KEY_FILE}"
    else
        echo "[WARN] Could not create ${AUTH_KEY_FILE}; auth credentials stay keyed to the machine-id"
    fi
fi

# Older versions of this image copied the downloader's OAuth token into the
# auth volume under four names. The server reads none of them; they were just
# stale plaintext copies of the token.
for stale in .hytale-downloader-credentials.json credentials.json .credentials oauth_credentials.json; do
    if [ -f "${AUTH_DIR}/${stale}" ]; then
        rm -f "${AUTH_DIR}/${stale}" && echo "[INFO] Removed stale token copy ${AUTH_DIR}/${stale}"
    fi
done

# ============================================================
# Check/Download server files
# ============================================================
echo "[INFO] Checking server files..."

SERVER_JAR="/opt/hytale/server/HytaleServer.jar"
ASSETS_FILE="/opt/hytale/server/Assets.zip"
DOWNLOADER_DIR="/opt/hytale/downloader"
CREDENTIALS_FILE="${DOWNLOADER_DIR}/.hytale-downloader-credentials.json"

# A patchline name as the downloader knows them ("release", "pre-release").
# panel-config.json lies in the data folder, which the server can write, and
# the value ends up on the downloader's command line and in .hytale-version.
valid_patchline() {
    case "$1" in
        '' | -* | *[!a-z0-9-]*) return 1 ;;
    esac
    [ "${#1}" -le 32 ]
}

# Function to get patchline from panel config or env
get_patchline() {
    local panel_config="/opt/hytale/data/panel-config.json" value

    # First try to read from panel config file (as hytale: root would follow a link there)
    if [ -f "$panel_config" ]; then
        # Extract patchline value from JSON using grep/sed (jq might not be available)
        value=$(gosu hytale cat "$panel_config" 2>/dev/null | grep -o '"patchline"[[:space:]]*:[[:space:]]*"[^"]*"' \
            | sed 's/.*"patchline"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' | head -n1)
        if valid_patchline "$value"; then
            echo "$value"
            return
        fi
        [ -n "$value" ] && echo "[WARN] Ignoring the invalid patchline in ${panel_config}" >&2
    fi

    # Fallback to environment variable or default
    value="${HYTALE_PATCHLINE:-release}"
    if valid_patchline "$value"; then
        echo "$value"
    else
        echo "[WARN] Invalid HYTALE_PATCHLINE, using release" >&2
        echo "release"
    fi
}

# Every downloader call goes through `downloader <seconds> <args...>`: one call
# at a time (the panel's version checks take the same lock, and any call may
# rewrite the credentials file when it refreshes the token) and never longer
# than <seconds>, so a hanging download or login prompt cannot block the start
# forever. Exit 124 = timed out, 75 = lock not acquired.
DOWNLOADER_LOCK="${DOWNLOADER_DIR}/.downloader.lock"
DOWNLOADER_TIMEOUT="${DOWNLOADER_TIMEOUT:-3600}"
case "$DOWNLOADER_TIMEOUT" in
    ''|*[!0-9]*|0) echo "[WARN] Invalid DOWNLOADER_TIMEOUT='${DOWNLOADER_TIMEOUT}', using 3600"; DOWNLOADER_TIMEOUT=3600 ;;
esac
DOWNLOADER_PROBE_TIMEOUT=120

# The lock file is opened as hytale too: the folder belongs to the server, and
# root would follow a link planted under the lock's name. timeout runs as
# hytale as well, so it can pass a stop (or its time limit) on to the
# downloader: without CAP_KILL root cannot signal the hytale processes.
downloader() {
    local limit="$1"
    shift
    run_interruptible gosu hytale timeout --kill-after=10 "$limit" flock -w 300 -E 75 "$DOWNLOADER_LOCK" \
        ./hytale-downloader-linux-amd64 "$@"
}

# Output of a downloader call that is parsed afterwards. Not captured with a
# command substitution: that would hold off a stop signal while the call runs.
DOWNLOADER_OUT=$(mktemp /tmp/downloader-out.XXXXXX)

# The image never replaces the downloader on its own (all calls pass
# -skip-update-check); a newer version is only reported. Update it from the
# panel's Update Center, or delete the binary to fetch the current one.
report_downloader_update() {
    local out
    downloader 30 -check-update > "$DOWNLOADER_OUT" 2>&1
    out=$(tr -d '\r' < "$DOWNLOADER_OUT")
    case "$out" in
        *"new version of hytale-downloader is available"*)
            echo "[INFO] $(printf '%s\n' "$out" | grep -m1 -o 'A new version of hytale-downloader is available: [^)]*)')"
            echo "[INFO] Update it from the panel (Updates -> Downloader) or delete ${DOWNLOADER_DIR}/hytale-downloader-linux-amd64 to download the current one."
            ;;
    esac
}

# write_version_file <version> <patchline>: line 1 version, line 2 patchline.
# Written as the hytale user via a temp file and a rename: the server folder
# belongs to the server, and root would write through (and chown) a link
# planted under that name.
write_version_file() {
    # shellcheck disable=SC2016
    gosu hytale sh -c 'printf "%s\n%s\n" "$2" "$3" > "$1.tmp" && mv -f "$1.tmp" "$1"' \
        sh "$VERSION_FILE" "$1" "$2" \
        || { echo "[WARN] Could not write $VERSION_FILE"; return 1; }
}

# Implementation-Version from a JAR manifest, read as hytale (empty if none).
jar_manifest_version() {
    gosu hytale unzip -p "$1" META-INF/MANIFEST.MF 2>/dev/null | tr -d '\r' \
        | sed -n 's/^Implementation-Version:[[:space:]]*//p' | head -n1 | grep -E '^[0-9A-Za-z._-]{1,64}$'
}

# The downloader has just installed the newest build of the panel's
# patchline. An update the server staged before is older, or for the other
# patchline (after a patchline switch), and the start script would install it
# over this build.
discard_staged_update() {
    local staging=/opt/hytale/updater/staging
    [ -e "$staging" ] || [ -L "$staging" ] || return 0
    if gosu hytale rm -rf -- "$staging"; then
        echo "[INFO] Discarded the update in updater/staging; the downloaded build replaces it"
    else
        echo "[WARN] Could not remove $staging; the start script would install it over the downloaded build"
    fi
}

# Function to run Hytale Downloader
run_downloader() {
    local UPDATE_MODE="$1"

    mkdir -p "$DOWNLOADER_DIR"
    chown hytale:hytale "$DOWNLOADER_DIR"

    # Download the downloader tool
    DOWNLOADER_BIN="${DOWNLOADER_DIR}/hytale-downloader-linux-amd64"

    if [ ! -f "$DOWNLOADER_BIN" ]; then
        echo "[INFO] Downloading Hytale Downloader from official source..."
        cd "$DOWNLOADER_DIR" || return 1
        PARTIAL_DOWNLOAD="${DOWNLOADER_DIR}/hytale-downloader.zip"
        run_interruptible gosu hytale wget -q --show-progress --timeout=60 --tries=3 -O hytale-downloader.zip "https://downloader.hytale.com/hytale-downloader.zip"
        PARTIAL_DOWNLOAD=""
        gosu hytale unzip -o hytale-downloader.zip
        gosu hytale chmod +x hytale-downloader-linux-amd64 2>/dev/null || true
        rm -f hytale-downloader.zip
    fi

    cd "$DOWNLOADER_DIR" || return 1
    report_downloader_update
    PATCHLINE=$(get_patchline)
    echo "[INFO] Using patchline: $PATCHLINE"
    DOWNLOAD_PATH="/opt/hytale/server/game.zip"
    # Line 1: version, line 2: patchline. start-server.sh rewrites it from
    # `java -jar HytaleServer.jar --version` on every start.
    VERSION_FILE="/opt/hytale/server/.hytale-version"

    # For update mode: Check version FIRST before downloading
    if [ "$UPDATE_MODE" = "update" ]; then
        # Without saved credentials the downloader starts a device login and
        # waits for it: nobody answers that during a container start.
        if [ ! -f "$CREDENTIALS_FILE" ]; then
            echo "[WARN] The downloader is not logged in - skipping the update check (log in from the panel)"
            return 0
        fi
        echo "[INFO] Checking for updates..."

        # Get latest version from downloader. The output carries the real
        # version (newer builds use a semver like 0.5.0) plus a YYYY.MM.DD
        # build-date stamp; prefer the non-date version, fall back to the date
        # only for the older date-based naming scheme.
        # -skip-update-check keeps the downloader's own "new version" notice
        # (it carries a date-like version) out of the parsed output.
        downloader "$DOWNLOADER_PROBE_TIMEOUT" -patchline "$PATCHLINE" -print-version -skip-update-check > "$DOWNLOADER_OUT" 2>/dev/null
        _VER_RAW=$(grep -oE '[0-9]+\.[0-9]+\.[0-9]+' "$DOWNLOADER_OUT")
        LATEST_VERSION=$(printf '%s\n' "$_VER_RAW" | grep -vE '^(19|20)[0-9]{2}\.(0[1-9]|1[0-2])\.(0[1-9]|[12][0-9]|3[01])$' | head -1)
        [ -z "$LATEST_VERSION" ] && LATEST_VERSION=$(printf '%s\n' "$_VER_RAW" | head -1)

        if [ -z "$LATEST_VERSION" ]; then
            echo "[WARN] Could not determine latest version (timeout, login required or offline), skipping update check"
            return 0
        fi

        # Get installed version (read as hytale: root would follow a link there)
        INSTALLED_VERSION=""
        if [ -f "$VERSION_FILE" ]; then
            INSTALLED_VERSION=$(gosu hytale head -n1 "$VERSION_FILE" | tr -d '\r[:space:]')
        fi

        echo "[INFO] Installed version: ${INSTALLED_VERSION:-unknown}"
        echo "[INFO] Latest version: $LATEST_VERSION"

        # Compare versions
        if [ "$INSTALLED_VERSION" = "$LATEST_VERSION" ]; then
            echo "[INFO] Server is already up to date! (v$INSTALLED_VERSION)"
            return 0
        fi

        echo "[INFO] Update available: $INSTALLED_VERSION -> $LATEST_VERSION"
        # Remove old zip to force download of new version
        rm -f "$DOWNLOAD_PATH"
    fi
    
    # Loop until download succeeds
    MAX_ATTEMPTS=60
    ATTEMPT=0
    
    while [ ! -f "$DOWNLOAD_PATH" ]; do
        ATTEMPT=$((ATTEMPT + 1))
        
        # Check if credentials exist
        if [ ! -f "$CREDENTIALS_FILE" ]; then
            echo ""
            echo "╔══════════════════════════════════════════════════════════╗"
            echo "║  AUTHENTICATION REQUIRED                                 ║"
            echo "╠══════════════════════════════════════════════════════════╣"
            echo "║  1. A URL and code will appear below                     ║"
            echo "║  2. Open the URL in your browser                         ║"
            echo "║  3. Enter the code and login with your Hytale account    ║"
            echo "║  4. Wait - download will start automatically             ║"
            echo "╚══════════════════════════════════════════════════════════╝"
            echo ""
        fi
        
        if [ "$UPDATE_MODE" = "update" ]; then
            echo "[INFO] Checking for updates (attempt ${ATTEMPT})..."
        else
            echo "[INFO] Attempting download (attempt ${ATTEMPT})..."
        fi
        
        # Output goes straight to the console (login URL and code included).
        # game.zip did not exist before: a stop removes what was written.
        PARTIAL_DOWNLOAD="$DOWNLOAD_PATH"
        downloader "$DOWNLOADER_TIMEOUT" -patchline "$PATCHLINE" -download-path "$DOWNLOAD_PATH" -skip-update-check
        RESULT=$?
        PARTIAL_DOWNLOAD=""

        if [ $RESULT -eq 0 ] && [ -f "$DOWNLOAD_PATH" ]; then
            echo "[INFO] Download successful!"
            break
        else
            # Exit code 3 = already up to date (no download needed)
            if [ $RESULT -eq 3 ]; then
                echo "[INFO] Server is already up to date!"
                return 0
            fi

            if [ $RESULT -eq 124 ]; then
                echo "[WARN] Download timed out after ${DOWNLOADER_TIMEOUT}s (DOWNLOADER_TIMEOUT)"
            elif [ $RESULT -eq 75 ]; then
                echo "[WARN] Another downloader call is still running (lock ${DOWNLOADER_LOCK})"
            fi
            echo "[WARN] Download failed (exit code: $RESULT)"
            
            # If no credentials file exists after failure, it was an auth problem
            if [ ! -f "$CREDENTIALS_FILE" ]; then
                echo "[WARN] No credentials found - authentication may have failed"
            else
                echo "[INFO] Credentials exist - keeping them for retry (server may be overloaded)"
            fi
            
            if [ $ATTEMPT -ge $MAX_ATTEMPTS ]; then
                echo "[ERROR] Max attempts reached."
                
                # For updates, just continue with existing files
                if [ "$UPDATE_MODE" = "update" ]; then
                    echo "[WARN] Update check failed, continuing with existing files..."
                    return 1
                fi
                
                echo "[ERROR] Please check:"
                echo "  - Is your Hytale account valid?"
                echo "  - Do you own the game?"
                echo "  - Are Hytale servers online?"
                echo ""
                echo "[INFO] Container will keep running. You can:"
                echo "  1. Check logs and try again: docker restart hytale"
                echo "  2. Manually copy files: docker cp HytaleServer.jar hytale:/opt/hytale/server/"
                echo ""
                echo "[WAIT] Waiting for manual intervention..."
                
                # Wait forever instead of crashing
                while true; do
                    if [ -f "$SERVER_JAR" ] && [ -f "$ASSETS_FILE" ]; then
                        echo "[INFO] Files detected! Continuing..."
                        return 0
                    fi
                    run_interruptible sleep 10
                done
            fi

            echo "[INFO] Waiting 10 seconds before retry..."
            run_interruptible sleep 10
        fi
    done
    
    # Extract the downloaded zip
    if [ -f "$DOWNLOAD_PATH" ]; then
        echo "[INFO] Extracting game files..."
        cd /opt/hytale/server || return 1

        # Backup current JAR version info (if updating)
        if [ "$UPDATE_MODE" = "update" ] && [ -f "$SERVER_JAR" ]; then
            echo "[INFO] Updating server files..."
        fi

        # A stop now waits until the files are in place (see "Stop signals").
        CRITICAL=1

        # Capture the unzip exit code instead of assuming success. A failed
        # extraction (bad permissions, truncated zip, disk full) must NOT be
        # treated as a completed update: otherwise we would stamp the new
        # version number below while the OLD files remain on disk, and the
        # panel's update check would report "up to date" when it is not.
        if gosu hytale unzip -o game.zip; then
            UNZIP_OK=1
        else
            UNZIP_RC=$?
            UNZIP_OK=0
            echo "[ERROR] Extraction failed (unzip exit code ${UNZIP_RC})."
        fi

        # Move files to correct locations. As hytale: the server folder is the
        # server's, and root would move whatever a planted "Server" link
        # points to.
        if [ -d "Server" ]; then
            gosu hytale sh -c 'mv Server/* . 2>/dev/null; rm -rf Server' || true
        fi

        # Only treat the update as applied if extraction succeeded AND the
        # server jar is actually present afterwards.
        if [ "$UNZIP_OK" = "1" ] && [ -f "$SERVER_JAR" ]; then
            rm -f game.zip
            echo "[INFO] Extraction complete!"
            discard_staged_update

            # Save installed version to file for future update checks, still
            # before a pending stop is handled: without it the next start would
            # download the build again. A fresh install takes the version from
            # the JAR (as start-server.sh does on every start).
            SAVED_VERSION="${LATEST_VERSION:-$(jar_manifest_version "$SERVER_JAR")}"
            if [ -n "$SAVED_VERSION" ]; then
                write_version_file "$SAVED_VERSION" "$PATCHLINE" \
                    && echo "[INFO] Saved version $SAVED_VERSION to $VERSION_FILE"
            fi
            end_critical

            if [ -z "$SAVED_VERSION" ]; then
                # A JAR without a version in its manifest: ask the downloader.
                # Prefer the real (non-date) version over the YYYY.MM.DD
                # build-date stamp; fall back to the date only for the older
                # date-based naming.
                cd "$DOWNLOADER_DIR" || return 1
                downloader "$DOWNLOADER_PROBE_TIMEOUT" -patchline "$PATCHLINE" -print-version -skip-update-check > "$DOWNLOADER_OUT" 2>/dev/null
                _VER_RAW=$(grep -oE '[0-9]+\.[0-9]+\.[0-9]+' "$DOWNLOADER_OUT")
                INSTALLED_VER=$(printf '%s\n' "$_VER_RAW" | grep -vE '^(19|20)[0-9]{2}\.(0[1-9]|1[0-2])\.(0[1-9]|[12][0-9]|3[01])$' | head -1)
                [ -z "$INSTALLED_VER" ] && INSTALLED_VER=$(printf '%s\n' "$_VER_RAW" | head -1)
                if [ -n "$INSTALLED_VER" ]; then
                    write_version_file "$INSTALLED_VER" "$PATCHLINE" \
                        && echo "[INFO] Saved version $INSTALLED_VER to $VERSION_FILE"
                fi
            fi
        else
            end_critical
            # Extraction did not produce a usable server. Keep game.zip so the
            # next start can retry, and DO NOT touch the version file — the
            # server is still on the previous build. Surface the cause loudly:
            # the most common reason is wrong ownership/permissions on the
            # bind-mounted /opt/hytale/server (must be writable by uid 9999).
            echo "[ERROR] Update NOT applied: HytaleServer.jar missing after extraction."
            echo "[ERROR] Keeping game.zip for the next retry; staying on the previous version."
            echo "[ERROR] Check that /opt/hytale/server is owned/writable by uid 9999 (hytale):"
            ls -la /opt/hytale/server/ || true
            return 1
        fi
    fi

    return 0
}

# Check if files exist
if [ -f "$SERVER_JAR" ] && [ -f "$ASSETS_FILE" ]; then
    echo "[INFO] Server files found!"
    
    # Auto-update check. The panel's "Auto-updates" switch (panel-config.json
    # "autoUpdate") overrides the AUTO_UPDATE env var once it has been set.
    PANEL_AUTO_UPDATE=""
    if [ -f /opt/hytale/data/panel-config.json ]; then
        PANEL_AUTO_UPDATE=$(gosu hytale cat /opt/hytale/data/panel-config.json 2>/dev/null \
            | grep -o '"autoUpdate"[[:space:]]*:[[:space:]]*\(true\|false\)' \
            | sed 's/.*:[[:space:]]*//' | head -n1)
    fi
    [ -n "$PANEL_AUTO_UPDATE" ] && AUTO_UPDATE="$PANEL_AUTO_UPDATE"
    if [ "$AUTO_UPDATE" = "true" ] && [ "$USE_HYTALE_DOWNLOADER" = "true" ]; then
        echo "[INFO] AUTO_UPDATE enabled - checking for updates..."
        run_downloader "update"
    fi
    
# Option 1: Download URLs provided
elif [ -n "$SERVER_JAR_URL" ] && [ -n "$ASSETS_URL" ]; then
    echo "[INFO] Downloading server files from URLs..."
    
    # wget writes straight to the final name: a download cut short by a stop
    # is removed, or the next start would take it for the real file.
    if [ ! -f "$SERVER_JAR" ]; then
        echo "[INFO] Downloading HytaleServer.jar..."
        PARTIAL_DOWNLOAD="$SERVER_JAR"
        run_interruptible gosu hytale wget -q --show-progress -O "$SERVER_JAR" "$SERVER_JAR_URL"
        PARTIAL_DOWNLOAD=""
    fi

    if [ ! -f "$ASSETS_FILE" ]; then
        echo "[INFO] Downloading Assets.zip (~3GB)..."
        PARTIAL_DOWNLOAD="$ASSETS_FILE"
        run_interruptible gosu hytale wget -q --show-progress -O "$ASSETS_FILE" "$ASSETS_URL"
        PARTIAL_DOWNLOAD=""
    fi
    
    echo "[INFO] Download complete!"

# Option 2: Use official Hytale Downloader
elif [ "$USE_HYTALE_DOWNLOADER" = "true" ]; then
    echo "[INFO] Using official Hytale Downloader..."
    run_downloader "fresh"

# No method configured - wait for manual copy
else
    echo ""
    echo "╔══════════════════════════════════════════════════════════╗"
    echo "║  SERVER FILES NOT FOUND!                                 ║"
    echo "╠══════════════════════════════════════════════════════════╣"
    echo "║  Option 1: Set download URLs in Portainer                ║"
    echo "║    SERVER_JAR_URL=https://your-nas/HytaleServer.jar      ║"
    echo "║    ASSETS_URL=https://your-nas/Assets.zip                ║"
    echo "║                                                          ║"
    echo "║  Option 2: Use official Hytale Downloader                ║"
    echo "║    USE_HYTALE_DOWNLOADER=true                            ║"
    echo "║    (Requires OAuth login on first run)                   ║"
    echo "║                                                          ║"
    echo "║  Option 3: Copy files manually                           ║"
    echo "║    docker cp HytaleServer.jar hytale:/opt/hytale/server/ ║"
    echo "║    docker cp Assets.zip hytale:/opt/hytale/server/       ║"
    echo "║    docker restart hytale                                 ║"
    echo "╚══════════════════════════════════════════════════════════╝"
    echo ""
    echo "[WAIT] Waiting for server files..."
    
    while true; do
        if [ -f "$SERVER_JAR" ] && [ -f "$ASSETS_FILE" ]; then
            echo "[INFO] Files detected! Continuing..."
            break
        fi
        run_interruptible sleep 5
    done
fi

# ============================================================
# Final check
# ============================================================
if [ ! -f "$SERVER_JAR" ] || [ ! -f "$ASSETS_FILE" ]; then
    echo "[ERROR] Server files still missing!"
    echo "[ERROR] Expected: $SERVER_JAR"
    echo "[ERROR] Expected: $ASSETS_FILE"
    echo ""
    echo "Contents of /opt/hytale/server/:"
    ls -la /opt/hytale/server/ || true
    exit 1
fi

echo "[INFO] Server files verified!"

# ============================================================
# Update layout (native updater)
# ============================================================
# Hytale 0.7 only enables its update checker (and `/update download` without
# --force) when the parent of its working directory holds Assets.zip and a
# start.sh launcher, like the official server package. /opt/hytale is the
# container's own filesystem, so both are recreated on every start: a link to
# the real Assets.zip and the start script, which applies staged updates
# before each server start just like the official launcher.
ln -sfn /opt/hytale/server/Assets.zip /opt/hytale/Assets.zip
ln -sfn /opt/hytale/start-server.sh /opt/hytale/start.sh

# ============================================================
# Setup symlinks for persistence
# ============================================================
echo "[INFO] Setting up data directories..."

mkdir -p /opt/hytale/data/worlds
if [ ! -L "/opt/hytale/server/universe" ]; then
    rm -rf /opt/hytale/server/universe 2>/dev/null || true
    ln -sfn /opt/hytale/data /opt/hytale/server/universe
fi

mkdir -p /opt/hytale/plugins
ln -sfn /opt/hytale/plugins /opt/hytale/server/plugins 2>/dev/null || true

mkdir -p /opt/hytale/mods
ln -sfn /opt/hytale/mods /opt/hytale/server/mods 2>/dev/null || true

# Auth credentials - symlink to persistent volume
mkdir -p /opt/hytale/auth
if [ ! -L "/opt/hytale/server/.auth" ]; then
    rm -rf /opt/hytale/server/.auth 2>/dev/null || true
    ln -sfn /opt/hytale/auth /opt/hytale/server/.auth
fi

# ============================================================
# Server log retention
# ============================================================
# The server opens a new logs/<timestamp>_server.log on every start and never
# deletes old ones. Drop logs older than LOG_RETENTION_DAYS days and keep at
# most the newest LOG_MAX_FILES (0 disables either limit). A .lck file is left
# next to a log that was not closed cleanly; no server is running yet at this
# point, so any lock file found is stale.
cleanup_server_logs() {
    local dir="/opt/hytale/server/logs"
    local days="${LOG_RETENTION_DAYS:-14}"
    local max_files="${LOG_MAX_FILES:-50}"
    local removed=0 old=()
    # A symlinked logs folder is left alone: root must not delete through it.
    if [ ! -d "$dir" ] || [ -L "$dir" ]; then
        return 0
    fi
    case "$days" in
        ''|*[!0-9]*) echo "[WARN] Invalid LOG_RETENTION_DAYS='${days}', using 14"; days=14 ;;
    esac
    case "$max_files" in
        ''|*[!0-9]*) echo "[WARN] Invalid LOG_MAX_FILES='${max_files}', using 50"; max_files=50 ;;
    esac
    # Base 10 explicitly: "08" would otherwise be read as an invalid octal number.
    days=$((10#$days))
    max_files=$((10#$max_files))

    find "$dir" -maxdepth 1 -type f -name '*_server.log.lck' -delete
    if [ "$days" -gt 0 ]; then
        mapfile -d '' -t old < <(find "$dir" -maxdepth 1 -type f -name '*_server.log' \
            -mmin +"$((days * 1440))" -print0)
        if [ "${#old[@]}" -gt 0 ]; then
            rm -f -- "${old[@]}" && removed=$((removed + ${#old[@]}))
        fi
    fi
    if [ "$max_files" -gt 0 ]; then
        mapfile -d '' -t old < <(find "$dir" -maxdepth 1 -type f -name '*_server.log' \
            -printf '%T@ %p\0' | sort -z -rn | tail -z -n +"$((max_files + 1))" | cut -z -d' ' -f2-)
        if [ "${#old[@]}" -gt 0 ]; then
            rm -f -- "${old[@]}" && removed=$((removed + ${#old[@]}))
        fi
    fi
    if [ "$removed" -gt 0 ]; then
        echo "[INFO] Removed ${removed} old server log file(s) (LOG_RETENTION_DAYS=${days}, LOG_MAX_FILES=${max_files})"
    fi
}
cleanup_server_logs

# ============================================================
# Start server
# ============================================================
echo "[INFO] Starting Hytale Server..."
echo ""
rm -f -- "$DOWNLOADER_OUT"
# exec resets the stop trap to the default; start-server.sh sets its own at once.
exec gosu hytale /opt/hytale/start-server.sh
