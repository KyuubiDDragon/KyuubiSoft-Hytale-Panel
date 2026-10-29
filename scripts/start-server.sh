#!/bin/bash
# ============================================================
# Hytale Server - Start Script
# ============================================================
# pipefail catches mid-pipeline failures; we intentionally don't set -e
# because the restart loop checks java's exit code (8 == native update restart)
# and we don't set -u because several env vars are optional (AUTH_MODE,
# EXTRA_SERVER_ARGS, EXTRA_JAVA_ARGS) and -n "${VAR:-}" idioms add noise.
set -o pipefail

cd /opt/hytale/server || exit 1

# ------------------------------------------------------------
# Signal forwarding
# ------------------------------------------------------------
# This script runs as PID 1. The kernel only delivers signals to PID 1 that
# it has a handler for, and bash never passes them on to a foreground child,
# so `docker stop` used to SIGKILL Java once the grace period ran out: no
# shutdown sequence, nothing saved since the last auto-save. Java now runs in
# the background and this trap forwards the signal; Hytale 0.7 treats SIGTERM
# like /stop (saves the worlds, lets plugins flush, then exits).
STOP_REQUESTED=0
JAVA_PID=""
forward_stop() {
    STOP_REQUESTED=1
    if [ -n "$JAVA_PID" ]; then
        echo "[$(date +'%Y-%m-%d %H:%M:%S')] Stop signal received - shutting the server down cleanly..."
        kill -TERM "$JAVA_PID" 2>/dev/null
    fi
}
trap forward_stop TERM INT HUP

# ------------------------------------------------------------
# Exit codes (Hytale 0.7 shutdown reasons)
# ------------------------------------------------------------
describe_exit_code() {
    case "$1" in
        0) echo "normal shutdown (/stop)" ;;
        1) echo "server crashed (see the error above)" ;;
        2) echo "authentication failed: the server tokens were rejected" ;;
        3) echo "the world generation config could not be loaded" ;;
        5) echo "a required plugin or mod is missing" ;;
        6) echo "required game data failed validation" ;;
        7) echo "no asset pack could be loaded" ;;
        8) echo "restart requested to apply an update" ;;
        9) echo "a mod or plugin failed to load" ;;
        10) echo "world data failed verification (corrupted chunks?)" ;;
        11) echo "invalid install directory" ;;
        130 | 143) echo "stopped by a signal (docker stop, Ctrl+C)" ;;
        137) echo "killed (SIGKILL): out of memory, or a stop that took too long" ;;
        *) echo "unknown exit code" ;;
    esac
}

# Codes a plain restart cannot fix: retrying them only repeats the failure.
is_unrecoverable_exit() {
    case "$1" in
        2 | 3 | 5 | 6 | 7 | 9 | 10 | 11) return 0 ;;
        *) return 1 ;;
    esac
}

print_exit_hint() {
    case "$1" in
        2) echo "  -> Remove or renew the server tokens passed via environment or CLI, start the server and run: /auth login device" ;;
        3) echo "  -> Check the world generation settings of the world named in the error above." ;;
        5 | 9) echo "  -> Find the mod named in the error above and remove, update or re-add it (or add --ignore-broken-mods to the server arguments)." ;;
        7) echo "  -> Check that /opt/hytale/server/Assets.zip exists and matches the server version (re-run the download if needed)." ;;
        10) echo "  -> Restore the world from a backup." ;;
        11) echo "  -> The server must not run from inside the launcher's install directory." ;;
        137) echo "  -> If the container ran out of memory: lower JAVA_MAX_RAM or raise DOCKER_MEMORY_LIMIT." ;;
    esac
}

# Docker's restart policy (on-failure:3) would retry an unrecoverable exit three
# more times. The marker below makes those quick retries fail fast; a start
# from the panel removes it, and it expires after EXIT_GUARD_SECONDS so a later
# manual `docker start` works again. Format: "<exit code> <epoch seconds>".
EXIT_GUARD_FILE="/opt/hytale/data/.server-exit"
EXIT_GUARD_SECONDS=120

if [ -f "$EXIT_GUARD_FILE" ]; then
    read -r GUARD_CODE GUARD_TIME _ < "$EXIT_GUARD_FILE" 2>/dev/null
    GUARD_AGE=$(( $(date +%s) - ${GUARD_TIME:-0} ))
    if [[ "$GUARD_CODE" =~ ^[0-9]+$ ]] && is_unrecoverable_exit "$GUARD_CODE" \
        && [ "$GUARD_AGE" -ge 0 ] && [ "$GUARD_AGE" -lt "$EXIT_GUARD_SECONDS" ]; then
        echo "[ERROR] Not starting: the last run ended ${GUARD_AGE}s ago with exit code $GUARD_CODE ($(describe_exit_code "$GUARD_CODE"))."
        print_exit_hint "$GUARD_CODE"
        echo "[ERROR] Restarting does not fix this. Fix the cause, then start the server from the panel"
        echo "[ERROR] (or delete $EXIT_GUARD_FILE before 'docker start')."
        exit "$GUARD_CODE"
    fi
    rm -f "$EXIT_GUARD_FILE"
fi

# Server JAR (configurable for alternative launchers like Hyinit)
SERVER_JAR="${SERVER_JAR:-HytaleServer.jar}"

if [ ! -f "$SERVER_JAR" ]; then
    echo "[ERROR] Server JAR not found: $SERVER_JAR"
    echo "[ERROR] Make sure the file exists in /opt/hytale/server/"
    exit 1
fi

# ------------------------------------------------------------
# Panel config (written by the manager to the mounted data volume).
# Lets operators tune settings from the web UI; applied on next start.
# ------------------------------------------------------------
PANEL_CONFIG="/opt/hytale/data/panel-config.json"

# Read a boolean value from panel config.
get_panel_config_bool() {
    local key="$1"
    local default="$2"
    if [ -f "$PANEL_CONFIG" ]; then
        value=$(grep -o "\"$key\"[[:space:]]*:[[:space:]]*[a-z]*" "$PANEL_CONFIG" 2>/dev/null | sed 's/.*:[[:space:]]*//')
        if [ "$value" = "true" ]; then echo "true"; return; fi
        if [ "$value" = "false" ]; then echo "false"; return; fi
    fi
    echo "$default"
}

# Read a string value from panel config (empty if absent).
get_panel_config_string() {
    local key="$1"
    if [ -f "$PANEL_CONFIG" ]; then
        grep -o "\"$key\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$PANEL_CONFIG" 2>/dev/null \
            | sed 's/.*:[[:space:]]*"\([^"]*\)".*/\1/'
    fi
}

# Read a positive integer (1-1000) from panel config, or the default.
get_panel_config_int() {
    local key="$1"
    local default="$2"
    local value=""
    if [ -f "$PANEL_CONFIG" ]; then
        value=$(grep -o "\"$key\"[[:space:]]*:[[:space:]]*[0-9]*" "$PANEL_CONFIG" 2>/dev/null \
            | sed 's/.*:[[:space:]]*//' | head -n1)
    fi
    case "$value" in
        ''|*[!0-9]*) echo "$default" ;;
        *) if [ "$value" -ge 1 ] && [ "$value" -le 1000 ]; then echo "$value"; else echo "$default"; fi ;;
    esac
}

# Checks for the start parameters from the panel (see start-args.sh).
# shellcheck source=start-args.sh
. /opt/hytale/start-args.sh

# Panel RAM value of key $1, or nothing when it is unset or not a RAM size.
get_panel_ram() {
    local value reason
    value=$(get_panel_config_string "$1")
    [ -n "$value" ] || return 0
    if reason=$(check_panel_ram "$value"); then
        echo "$value"
    else
        echo "[WARN] Ignoring $1 from the panel: $reason" >&2
    fi
}

# JVM RAM overrides from the panel (fall back to the env defaults when unset).
PANEL_JAVA_MIN_RAM=$(get_panel_ram "javaMinRam")
PANEL_JAVA_MAX_RAM=$(get_panel_ram "javaMaxRam")
[ -n "$PANEL_JAVA_MIN_RAM" ] && JAVA_MIN_RAM="$PANEL_JAVA_MIN_RAM"
[ -n "$PANEL_JAVA_MAX_RAM" ] && JAVA_MAX_RAM="$PANEL_JAVA_MAX_RAM"

# Heap vs. container memory limit. A heap that leaves the JVM no room inside
# the cgroup limit gets the container OOM-killed (exit 137), and Docker's
# restart policy repeats that a few times before giving up. The panel refuses
# such values; RAM set through the environment is only checked here. Same rule
# as the panel: keep a quarter of the limit, at most 1.5 GB, for the JVM itself.
JVM_HEADROOM_MAX_MB=1536

# "4G", "512m", "1048576k" or plain bytes -> MB (empty if not a JVM size).
ram_to_mb() {
    local v="${1^^}"
    [[ "$v" =~ ^([0-9]{1,12})([GMK]?)$ ]] || return 0
    local n=$((10#${BASH_REMATCH[1]}))
    case "${BASH_REMATCH[2]}" in
        G) echo $(( n * 1024 )) ;;
        M) echo "$n" ;;
        K) echo $(( n / 1024 )) ;;
        *) echo $(( n / 1024 / 1024 )) ;;
    esac
}

container_memory_limit_mb() {
    local raw=""
    if [ -r /sys/fs/cgroup/memory.max ]; then
        raw=$(cat /sys/fs/cgroup/memory.max)                       # cgroup v2
    elif [ -r /sys/fs/cgroup/memory/memory.limit_in_bytes ]; then
        raw=$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes)     # cgroup v1
    fi
    case "$raw" in
        ''|max|*[!0-9]*) return 0 ;;
    esac
    # cgroup v1 reports "no limit" as a number close to 2^63
    [ "${#raw}" -gt 15 ] && return 0
    echo $(( raw / 1024 / 1024 ))
}

check_heap_fits_container() {
    local limit_mb xmx_mb xms_mb headroom_mb
    limit_mb=$(container_memory_limit_mb)
    xmx_mb=$(ram_to_mb "$JAVA_MAX_RAM")
    xms_mb=$(ram_to_mb "$JAVA_MIN_RAM")
    if [ -n "$xms_mb" ] && [ -n "$xmx_mb" ] && [ "$xms_mb" -gt "$xmx_mb" ]; then
        echo "[WARN] Min RAM ${JAVA_MIN_RAM} is larger than max RAM ${JAVA_MAX_RAM}; the JVM will refuse to start."
    fi
    [ -n "$limit_mb" ] && [ -n "$xmx_mb" ] || return 0
    headroom_mb=$(( limit_mb / 4 ))
    [ "$headroom_mb" -gt "$JVM_HEADROOM_MAX_MB" ] && headroom_mb=$JVM_HEADROOM_MAX_MB
    if [ "$xmx_mb" -gt $(( limit_mb - headroom_mb )) ]; then
        echo "[WARN] Max RAM ${JAVA_MAX_RAM} does not fit the container memory limit of ${limit_mb} MB:"
        echo "[WARN] the JVM needs about ${headroom_mb} MB on top of the heap. Expect an out-of-memory kill (exit 137)."
        echo "[WARN] Lower the max RAM in the panel (or JAVA_MAX_RAM) or raise DOCKER_MEMORY_LIMIT."
    fi
}
check_heap_fits_container

# AOT cache (-XX:AOTCache). Off unless enabled in the panel: an AOT cache only
# works with the exact JVM build that created it, and the HytaleServer.aot
# shipped with the server was made for a different one, so Java rejects it
# with an error and starts normally - it never made the start faster.
AOT_ARGS=()
if [ "$(get_panel_config_bool "aotCache" "false")" = "true" ]; then
    if [ "$SERVER_JAR" = "HytaleServer.jar" ] && [ -f "HytaleServer.aot" ]; then
        echo "[INFO] AOT cache enabled in the panel; Java ignores it if it was built by another JVM"
        AOT_ARGS=("-XX:AOTCache=HytaleServer.aot")
    else
        echo "[INFO] AOT cache enabled in the panel, but there is no HytaleServer.aot - starting without it"
    fi
fi

# Java arguments (optimized for game servers)
JAVA_ARGS=(
    "-Xms${JAVA_MIN_RAM}"
    "-Xmx${JAVA_MAX_RAM}"
    "-XX:+UseG1GC"
    "-XX:+ParallelRefProcEnabled"
    "-XX:MaxGCPauseMillis=200"
    "-XX:+UnlockExperimentalVMOptions"
    "-XX:+DisableExplicitGC"
    "-XX:+AlwaysPreTouch"
    "-XX:G1NewSizePercent=30"
    "-XX:G1MaxNewSizePercent=40"
    "-XX:G1HeapRegionSize=8M"
    "-XX:G1ReservePercent=20"
    "-XX:G1HeapWastePercent=5"
    "-XX:G1MixedGCCountTarget=4"
    "-XX:InitiatingHeapOccupancyPercent=15"
    "-XX:G1MixedGCLiveThresholdPercent=90"
    "-XX:G1RSetUpdatingPauseTimePercent=5"
    "-XX:SurvivorRatio=32"
    "-XX:+PerfDisableSharedMem"
    "-XX:MaxTenuringThreshold=1"
    "${AOT_ARGS[@]}"
)

# Server arguments
# --universe: the worlds live in the data volume. server/universe is only a
# symlink to it (kept for tools that use that path); Hytale 0.7 does not follow
# a symlinked universe when it packs a backup, which made every native backup
# an empty zip.
SERVER_ARGS=(
    "--assets" "Assets.zip"
    "--bind" "${SERVER_BIND}:${SERVER_PORT}"
    "--universe" "/opt/hytale/data"
)

# Native backups. The directory is always set: it makes /backup work and lets
# the server back up the worlds before it applies an update. ENABLE_BACKUP
# only adds the periodic backups. Retention comes from the panel.
NATIVE_BACKUP_DIR="/opt/hytale/backups/native"
mkdir -p "$NATIVE_BACKUP_DIR" 2>/dev/null \
    || echo "[WARN] Could not create $NATIVE_BACKUP_DIR; native backups will fail"
SERVER_ARGS+=(
    "--backup-dir" "$NATIVE_BACKUP_DIR"
    "--backup-max-count" "$(get_panel_config_int "nativeBackupMaxCount" 5)"
    "--backup-archive-max-count" "$(get_panel_config_int "nativeBackupArchiveMaxCount" 5)"
)
if [ "${ENABLE_BACKUP}" = "true" ]; then
    SERVER_ARGS+=("--backup" "--backup-frequency" "${BACKUP_FREQUENCY}")
fi

# Add auth mode if set
if [ -n "${AUTH_MODE}" ]; then
    SERVER_ARGS+=("--auth-mode" "${AUTH_MODE}")
fi

# Add --accept-early-plugins if enabled in panel config
ACCEPT_EARLY_PLUGINS=$(get_panel_config_bool "acceptEarlyPlugins" "false")
if [ "$ACCEPT_EARLY_PLUGINS" = "true" ]; then
    echo "[INFO] Accept Early Plugins enabled"
    SERVER_ARGS+=("--accept-early-plugins")
fi

# Add --disable-sentry if enabled in panel config (useful for plugin development)
DISABLE_SENTRY=$(get_panel_config_bool "disableSentry" "false")
if [ "$DISABLE_SENTRY" = "true" ]; then
    echo "[INFO] Sentry crash reporting disabled"
    SERVER_ARGS+=("--disable-sentry")
fi

# Add --allow-op if enabled in panel config. Off unless explicitly chosen:
# the flag unlocks `/op self`, which gives full admin rights to ANY player who
# types it. Admins are made from the console with `/op add <name>` instead.
ALLOW_OP=$(get_panel_config_bool "allowOp" "false")
if [ "$ALLOW_OP" = "true" ]; then
    echo "[WARN] --allow-op is enabled: any player can grant themselves full admin rights with /op self."
    echo "[WARN] Disable it in the panel settings and make admins from the console with /op add <name>."
    SERVER_ARGS+=("--allow-op")
fi

# Plugins uploaded through the panel (and StackMart "plugins") are stored in
# /opt/hytale/plugins, but the server only loads mods/ and the directories
# passed with --mods. Hytale 0.7 stops with exit code 9 when the same plugin
# (manifest Group:Name) is found twice, so the directory is only added while
# none of its plugins is also in mods/.
PLUGINS_DIR="/opt/hytale/plugins"
MODS_DIR="/opt/hytale/mods"

plugin_id() {
    unzip -p "$1" manifest.json 2>/dev/null \
        | jq -r 'select(type == "object" and (.Name | type) == "string") | "\(.Group // ""):\(.Name)"' 2>/dev/null \
        | head -n1
}

add_plugins_dir() {
    [ -d "$PLUGINS_DIR" ] || return 0
    local jar id duplicates=""
    local -A seen=()
    if command -v unzip >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
        shopt -s nullglob nocaseglob
        for jar in "$MODS_DIR"/*.jar; do
            id=$(plugin_id "$jar")
            [ -n "$id" ] && seen["$id"]="mods/${jar##*/}"
        done
        for jar in "$PLUGINS_DIR"/*.jar; do
            id=$(plugin_id "$jar")
            [ -n "$id" ] || continue
            [ -n "${seen[$id]:-}" ] && duplicates+=" ${id} (${seen[$id]} + plugins/${jar##*/});"
            seen["$id"]="plugins/${jar##*/}"
        done
        shopt -u nullglob nocaseglob
    else
        echo "[WARN] unzip/jq missing - cannot check /opt/hytale/plugins for duplicate plugins"
    fi
    if [ -n "$duplicates" ]; then
        echo "[WARN] Not loading $PLUGINS_DIR: these plugins are installed twice:${duplicates}"
        echo "[WARN] The server stops on duplicate plugins. Remove one copy of each and restart."
        return 0
    fi
    SERVER_ARGS+=("--mods" "$PLUGINS_DIR")
}
add_plugins_dir

# Boot commands from the panel: one --boot-command per entry, run in order
# once the server has booted. Hytale splits every value at commas and expects
# the command without a leading slash; the panel stores them that way, entries
# that still contain a comma or a line break are skipped.
if [ -f "$PANEL_CONFIG" ] && command -v jq >/dev/null 2>&1; then
    while IFS= read -r BOOT_COMMAND; do
        [ -n "$BOOT_COMMAND" ] || continue
        echo "[INFO] Boot command: $BOOT_COMMAND"
        SERVER_ARGS+=("--boot-command" "$BOOT_COMMAND")
    done < <(jq -r '(.bootCommands // []) | if type == "array" then .[] else empty end
        | select(type == "string") | sub("^/"; "") | select(test("[,\\r\\n]") | not)' \
        "$PANEL_CONFIG" 2>/dev/null)
fi

# Arguments for the log, with the values of secret-looking options masked
# (--session-token, --identity-token, -D...password=...): the container log is
# shown in the panel, and EXTRA_SERVER_ARGS / EXTRA_JAVA_ARGS can carry tokens.
redact_args() {
    local arg lower mask_next=0 out=()
    for arg in "$@"; do
        if [ "$mask_next" = 1 ]; then
            out+=("***")
            mask_next=0
            continue
        fi
        lower="${arg,,}"
        case "$lower" in
            --*token*=* | --*secret*=* | --*password*=* | -d*token*=* | -d*secret*=* | -d*password*=*)
                out+=("${arg%%=*}=***") ;;
            --*token* | --*secret* | --*password*)
                out+=("$arg")
                mask_next=1 ;;
            *) out+=("$arg") ;;
        esac
    done
    printf '%s' "${out[*]}"
}

# Custom server arguments (for alternative launchers or advanced config)
if [ -n "${EXTRA_SERVER_ARGS}" ]; then
    # Split EXTRA_SERVER_ARGS by spaces into array
    read -ra CUSTOM_ARGS <<< "${EXTRA_SERVER_ARGS}"
    echo "[INFO] Custom server arguments: $(redact_args "${CUSTOM_ARGS[@]}")"
    SERVER_ARGS+=("${CUSTOM_ARGS[@]}")
fi

# Custom Java arguments (for advanced JVM tuning)
if [ -n "${EXTRA_JAVA_ARGS}" ]; then
    read -ra CUSTOM_JAVA <<< "${EXTRA_JAVA_ARGS}"
    echo "[INFO] Custom Java arguments: $(redact_args "${CUSTOM_JAVA[@]}")"
    JAVA_ARGS+=("${CUSTOM_JAVA[@]}")
fi

# Java arguments without the collector choice when the panel picks another one
# (two collectors stop the JVM).
java_args_for_panel() {
    local arg
    for arg in "${JAVA_ARGS[@]}"; do
        if [ "$arg" = "-XX:+UseG1GC" ] && panel_selects_collector "$@"; then
            continue
        fi
        printf '%s\0' "$arg"
    done
}

# A JVM option the checks let through can still keep Java from starting (a
# misspelled -XX flag, a value out of range, a clash with the base options).
# The panel's options are tried once with `java -version` and the real
# arguments (no pre-touch and AOT cache, so it is quick); prints Java's
# complaint when it refuses them. When the base arguments alone fail as well,
# the panel's options are not to blame and are kept.
preflight_java_args() {
    local out arg base=()
    while IFS= read -r -d '' arg; do
        case "$arg" in
            -XX:+AlwaysPreTouch | -XX:AOTCache=*) ;;
            *) base+=("$arg") ;;
        esac
    done < <(java_args_for_panel "$@")
    out=$(timeout 60 java "${base[@]}" "$@" -version 2>&1) && return 0
    timeout 60 java "${base[@]}" -version >/dev/null 2>&1 || return 0
    printf '%s\n' "$out" | grep -v -e '^openjdk version' -e '^OpenJDK ' | head -n 3
    return 1
}

# Extra args from the panel config (appended after any env-provided ones).
# They are checked again here: a value saved by an older panel version (or
# edited by hand) that the panel would refuse now is left out as a whole, and
# so is one Java refuses; the server then starts without it.
PANEL_EXTRA_SERVER_ARGS=$(get_panel_config_string "extraServerArgs")
if [ -n "${PANEL_EXTRA_SERVER_ARGS}" ]; then
    if REASON=$(check_panel_server_args "${PANEL_EXTRA_SERVER_ARGS}"); then
        echo "[INFO] Panel server arguments: ${PANEL_EXTRA_SERVER_ARGS}"
        read -ra PANEL_SRV <<< "${PANEL_EXTRA_SERVER_ARGS}"
        SERVER_ARGS+=("${PANEL_SRV[@]}")
    else
        echo "[WARN] Ignoring the server arguments from the panel: ${REASON}"
        echo "[WARN] Correct them in the panel (Settings -> Server Memory & JVM)."
    fi
fi
# -Xlog files go to logs/ (the only place the panel allows); Java does not
# create the folder, and the server only does so after Java has started.
mkdir -p logs 2>/dev/null
PANEL_EXTRA_JAVA_ARGS=$(get_panel_config_string "extraJavaArgs")
if [ -n "${PANEL_EXTRA_JAVA_ARGS}" ]; then
    read -ra PANEL_JVM <<< "${PANEL_EXTRA_JAVA_ARGS}"
    if ! REASON=$(check_panel_java_args "${PANEL_EXTRA_JAVA_ARGS}"); then
        echo "[WARN] Ignoring the Java arguments from the panel: ${REASON}"
        echo "[WARN] Correct them in the panel (Settings -> Server Memory & JVM)."
    elif ! REASON=$(preflight_java_args "${PANEL_JVM[@]}"); then
        echo "[WARN] Java refuses the Java arguments from the panel; starting without them:"
        printf '%s\n' "${REASON}" | sed 's/^/[WARN]   /'
    else
        echo "[INFO] Panel Java arguments: ${PANEL_EXTRA_JAVA_ARGS}"
        # A collector chosen in the panel replaces G1.
        mapfile -d '' -t JAVA_ARGS < <(java_args_for_panel "${PANEL_JVM[@]}")
        JAVA_ARGS+=("${PANEL_JVM[@]}")
    fi
fi

# ------------------------------------------------------------
# Native updates
# ------------------------------------------------------------
# `/update download` stages a new build in ../updater/staging (seen from the
# server's working directory); `/update apply --confirm` backs the current
# files up to ../updater/backup and exits with code 8. Like the official
# launcher, this script then puts the staged files in place before the next
# start - on every start, so an update staged before a container restart is
# applied as well. The launcher's own start.sh is not copied: /opt/hytale/start.sh
# is this script.
UPDATER_DIR="/opt/hytale/updater"
STAGING_DIR="$UPDATER_DIR/staging"
UPDATE_BACKUP_DIR="$UPDATER_DIR/backup"
SERVER_DIR="/opt/hytale/server"
VERSION_FILE="$SERVER_DIR/.hytale-version"

log_ts() { echo "[$(date +'%Y-%m-%d %H:%M:%S')] $*"; }

# Implementation-Version from a JAR manifest (empty when unreadable).
jar_version() {
    unzip -p "$1" META-INF/MANIFEST.MF 2>/dev/null | tr -d '\r' \
        | sed -n 's/^Implementation-Version:[[:space:]]*//p' | head -n1
}

# Copy (or, with "move", move) $1 to a temporary name next to $2. The final
# rename happens in commit_temp, so a full disk never leaves a truncated file
# in place of a working one.
stage_temp() {
    local mode="$1" src="$2" dst="$3" tmp
    tmp="$(dirname "$dst")/.$(basename "$dst").update-tmp"
    rm -rf "$tmp"
    if [ "$mode" = "move" ]; then
        mv -f "$src" "$tmp" || { rm -rf "$tmp"; return 1; }
    else
        cp -rf "$src" "$tmp" || { rm -rf "$tmp"; return 1; }
    fi
}

commit_temp() {
    local dst="$1" tmp
    tmp="$(dirname "$dst")/.$(basename "$dst").update-tmp"
    [ -e "$tmp" ] || return 0
    if [ -d "$tmp" ]; then rm -rf "$dst"; fi
    mv -f "$tmp" "$dst"
}

discard_temps() {
    rm -rf "$SERVER_DIR/.HytaleServer.jar.update-tmp" "$SERVER_DIR/.HytaleServer.aot.update-tmp" \
        "$SERVER_DIR/.Licenses.update-tmp" "$SERVER_DIR/.Assets.zip.update-tmp"
}

# Keeps the replaced version in updater/backup unless it is already there
# (`/update apply` writes it; an automatic apply and a plain restart with a
# staged update do not). It is the source for the panel's rollback.
backup_current_files() {
    local current backed_up tmp="$UPDATER_DIR/.backup.update-tmp"
    current=$(jar_version "$SERVER_DIR/HytaleServer.jar")
    backed_up=$(jar_version "$UPDATE_BACKUP_DIR/Server/HytaleServer.jar")
    if [ -n "$current" ] && [ "$current" = "$backed_up" ] && [ -f "$UPDATE_BACKUP_DIR/Assets.zip" ]; then
        return 0
    fi
    log_ts "[Updater] Backing up the current version ${current:-unknown} to updater/backup ..."
    rm -rf "$tmp"
    mkdir -p "$tmp/Server" || return 1
    cp -f "$SERVER_DIR/HytaleServer.jar" "$tmp/Server/" || { rm -rf "$tmp"; return 1; }
    if [ -f "$SERVER_DIR/HytaleServer.aot" ]; then
        cp -f "$SERVER_DIR/HytaleServer.aot" "$tmp/Server/" || { rm -rf "$tmp"; return 1; }
    fi
    if [ -d "$SERVER_DIR/Licenses" ]; then
        cp -rf "$SERVER_DIR/Licenses" "$tmp/Server/" || { rm -rf "$tmp"; return 1; }
    fi
    if [ -f "$SERVER_DIR/Assets.zip" ]; then
        cp -f "$SERVER_DIR/Assets.zip" "$tmp/" || { rm -rf "$tmp"; return 1; }
    fi
    rm -rf "$UPDATE_BACKUP_DIR" && mv "$tmp" "$UPDATE_BACKUP_DIR"
}

apply_staged_update() {
    [ -f "$STAGING_DIR/Server/HytaleServer.jar" ] || return 0
    local from to
    from=$(jar_version "$SERVER_DIR/HytaleServer.jar")
    to=$(jar_version "$STAGING_DIR/Server/HytaleServer.jar")
    log_ts "[Updater] Applying staged update ${to:-unknown} (installed: ${from:-unknown}) ..."

    if [ -f "$SERVER_DIR/HytaleServer.jar" ] && ! backup_current_files; then
        log_ts "[Updater] ERROR: could not back up the current files (disk full?). The update was NOT applied;"
        log_ts "[Updater] the staged files stay in updater/staging and are applied on the next start."
        rm -rf "$UPDATER_DIR/.backup.update-tmp"
        return 1
    fi

    # Prepare everything next to its destination first (the big Assets.zip
    # last), then swap by rename: a failure before the swap changes nothing.
    if ! stage_temp copy "$STAGING_DIR/Server/HytaleServer.jar" "$SERVER_DIR/HytaleServer.jar" \
        || { [ -f "$STAGING_DIR/Server/HytaleServer.aot" ] \
            && ! stage_temp copy "$STAGING_DIR/Server/HytaleServer.aot" "$SERVER_DIR/HytaleServer.aot"; } \
        || { [ -d "$STAGING_DIR/Server/Licenses" ] \
            && ! stage_temp copy "$STAGING_DIR/Server/Licenses" "$SERVER_DIR/Licenses"; } \
        || { [ -f "$STAGING_DIR/Assets.zip" ] \
            && ! stage_temp move "$STAGING_DIR/Assets.zip" "$SERVER_DIR/Assets.zip"; }; then
        discard_temps
        log_ts "[Updater] ERROR: could not copy the staged files (disk full?). The update was NOT applied."
        return 1
    fi
    commit_temp "$SERVER_DIR/Assets.zip"
    commit_temp "$SERVER_DIR/HytaleServer.aot"
    commit_temp "$SERVER_DIR/Licenses"
    if ! commit_temp "$SERVER_DIR/HytaleServer.jar"; then
        log_ts "[Updater] ERROR: could not replace HytaleServer.jar; restore it from updater/backup."
        return 1
    fi
    rm -rf "$STAGING_DIR"
    log_ts "[Updater] Update ${to:-unknown} applied. The previous version is kept in updater/backup."
}

# Records the version of the JAR that is about to start, read from the JAR
# itself (`--version` only parses the arguments and prints, ~0.5 s): line 1
# version, line 2 patchline. The panel and the downloader's update check read
# this file, so it must be right after updates, rollbacks and manual copies.
stamp_server_version() {
    local out version patchline
    [ -f "$SERVER_DIR/HytaleServer.jar" ] || return 0
    # "HytaleServer v0.7.3 (release)" / "HytaleServer v0.7.3 (pre-release, <env>)"
    out=$(cd "$SERVER_DIR" && timeout 60 java -Xmx64m -XX:TieredStopAtLevel=1 -jar HytaleServer.jar --version 2>/dev/null \
        | tr -d '\r' | grep -m1 '^HytaleServer v')
    version=$(printf '%s\n' "$out" | sed -n 's/^HytaleServer v\([^ ]*\).*/\1/p')
    patchline=$(printf '%s\n' "$out" | sed -n 's/^[^(]*(\([^,)]*\).*/\1/p')
    if [ -z "$version" ]; then
        log_ts "[WARN] Could not read the server version (java -jar HytaleServer.jar --version)"
        return 0
    fi
    if printf '%s\n%s\n' "$version" "$patchline" > "$VERSION_FILE.tmp" && mv -f "$VERSION_FILE.tmp" "$VERSION_FILE"; then
        log_ts "[INFO] Server version: $version${patchline:+ ($patchline)}"
    else
        rm -f "$VERSION_FILE.tmp"
        log_ts "[WARN] Could not write $VERSION_FILE"
    fi
}

echo "============================================================"
echo "Starting with: java $(redact_args "${JAVA_ARGS[@]}") -jar ${SERVER_JAR} $(redact_args "${SERVER_ARGS[@]}")"
echo "============================================================"
echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  WICHTIG: Nach dem ersten Start authentifizieren!        ║"
echo "║                                                          ║"
echo "║  Im Server-Terminal eingeben:  /auth login device        ║"
echo "║                                                          ║"
echo "║  Dann den angezeigten Link im Browser öffnen.            ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# ============================================================
# Server Restart Loop (handles Exit Code 8 for updates)
# ============================================================
# Exit Code 8 = Server requests restart for update (Hytale native update system)
# The server downloads updates to updater/staging/ and exits with code 8
# On restart, updates are applied automatically by the launcher

exit_if_stop_requested() {
    if [ "$STOP_REQUESTED" = 1 ]; then
        echo "[$(date +'%Y-%m-%d %H:%M:%S')] Stop requested - not starting the server again."
        exit 143
    fi
}

while true; do
    exit_if_stop_requested

    # Staged update first (first start and after exit code 8), then record
    # the version that is about to run.
    apply_staged_update
    stamp_server_version
    # Both can take a while (a 4 GB copy, a JVM start); a stop that came in
    # meanwhile must not start the server.
    exit_if_stop_requested

    # Background job so the trap above can run; `<&0` keeps the console:
    # a non-interactive shell would otherwise give the job /dev/null as stdin.
    java "${JAVA_ARGS[@]}" -jar "${SERVER_JAR}" "${SERVER_ARGS[@]}" <&0 &
    JAVA_PID=$!
    while true; do
        wait "$JAVA_PID"
        EXIT_CODE=$?
        # A forwarded signal interrupts `wait` (status 128+n) while Java is
        # still shutting down; keep waiting for its real exit status.
        kill -0 "$JAVA_PID" 2>/dev/null || break
    done
    JAVA_PID=""

    echo ""
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] Server exited with code $EXIT_CODE: $(describe_exit_code "$EXIT_CODE")"
    print_exit_hint "$EXIT_CODE"

    if [ "$EXIT_CODE" -eq 8 ] && [ "$STOP_REQUESTED" = 0 ]; then
        echo "[$(date +'%Y-%m-%d %H:%M:%S')] Update restart requested (Exit Code 8)"
        if [ -f "$STAGING_DIR/Server/HytaleServer.jar" ]; then
            echo "[$(date +'%Y-%m-%d %H:%M:%S')] Staged update found - applying it before the restart..."
        else
            echo "[$(date +'%Y-%m-%d %H:%M:%S')] [WARN] No staged update in updater/staging - restarting the installed version."
        fi

        sleep 2
        echo "[$(date +'%Y-%m-%d %H:%M:%S')] Restarting server..."
        echo ""
        continue
    fi

    # Any other exit code = stop container
    if is_unrecoverable_exit "$EXIT_CODE"; then
        echo "$EXIT_CODE $(date +%s)" > "$EXIT_GUARD_FILE" 2>/dev/null \
            || echo "[WARN] Could not write $EXIT_GUARD_FILE"
        echo "[$(date +'%Y-%m-%d %H:%M:%S')] A restart cannot fix this - automatic restarts are skipped until the server is started again."
    fi
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] Server stopped. Container exiting with code: $EXIT_CODE"
    exit "$EXIT_CODE"
done
