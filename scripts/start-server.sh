#!/bin/bash
# ============================================================
# Hytale Server - Start Script
# ============================================================

cd /opt/hytale/server

# Check for AOT cache
AOT_FLAG=""
if [ -f "HytaleServer.aot" ]; then
    echo "[INFO] AOT cache found - enabling fast startup"
    AOT_FLAG="-XX:AOTCache=HytaleServer.aot"
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
    $AOT_FLAG
)

# Server arguments
SERVER_ARGS=(
    "--assets" "Assets.zip"
    "--bind" "${SERVER_BIND}:${SERVER_PORT}"
)

# Add backup if enabled
if [ "${ENABLE_BACKUP}" = "true" ]; then
    SERVER_ARGS+=(
        "--backup"
        "--backup-dir" "/opt/hytale/backups"
        "--backup-frequency" "${BACKUP_FREQUENCY}"
    )
fi

# Add auth mode if set
if [ -n "${AUTH_MODE}" ]; then
    SERVER_ARGS+=("--auth-mode" "${AUTH_MODE}")
fi

# Read panel config for additional settings
PANEL_CONFIG="/opt/hytale/data/panel-config.json"

# Function to read boolean value from panel config
get_panel_config_bool() {
    local key="$1"
    local default="$2"
    if [ -f "$PANEL_CONFIG" ]; then
        value=$(grep -o "\"$key\"[[:space:]]*:[[:space:]]*[a-z]*" "$PANEL_CONFIG" 2>/dev/null | sed 's/.*:[[:space:]]*//')
        if [ "$value" = "true" ]; then
            echo "true"
            return
        elif [ "$value" = "false" ]; then
            echo "false"
            return
        fi
    fi
    echo "$default"
}

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

# Add --allow-op if enabled in panel config
ALLOW_OP=$(get_panel_config_bool "allowOp" "false")
if [ "$ALLOW_OP" = "true" ]; then
    echo "[INFO] OP commands allowed"
    SERVER_ARGS+=("--allow-op")
fi

echo "============================================================"
echo "Starting with: java ${JAVA_ARGS[*]} -jar HytaleServer.jar ${SERVER_ARGS[*]}"
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

exec java "${JAVA_ARGS[@]}" -jar HytaleServer.jar "${SERVER_ARGS[@]}"
