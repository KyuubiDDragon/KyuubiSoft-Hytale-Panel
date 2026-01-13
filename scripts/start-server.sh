#!/bin/bash
# ============================================================
# Hytale Server - Start Script
# ============================================================

set -e

cd /opt/hytale/server

# Build Java arguments
JAVA_ARGS=(
    # Memory settings
    "-Xms${JAVA_MIN_RAM}"
    "-Xmx${JAVA_MAX_RAM}"
    
    # GC optimization for game servers
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
    
    # AOT cache if available
    ${AOT_FLAG}
    
    # Disable Sentry crash reporting (optional - for privacy)
    # Uncomment next line to disable:
    # "--disable-sentry"
)

# Build server arguments
SERVER_ARGS=(
    "--assets" "${ASSETS_FILE}"
    "--bind" "${SERVER_BIND}:${SERVER_PORT}"
)

# Add backup arguments if enabled
if [ "${ENABLE_BACKUP}" = "true" ]; then
    SERVER_ARGS+=(
        "--backup"
        "--backup-dir" "/opt/hytale/backups"
        "--backup-frequency" "${BACKUP_FREQUENCY}"
    )
fi

# Add auth mode if specified
if [ -n "${AUTH_MODE}" ]; then
    SERVER_ARGS+=("--auth-mode" "${AUTH_MODE}")
fi

echo "============================================================"
echo "Starting Hytale Server with:"
echo "  Java: ${JAVA_ARGS[*]}"
echo "  Server: ${SERVER_ARGS[*]}"
echo "============================================================"
echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  WICHTIG: Nach dem ersten Start musst du den Server     ║"
echo "║  authentifizieren! Führe im Server-Console aus:         ║"
echo "║                                                          ║"
echo "║    /auth login device                                    ║"
echo "║                                                          ║"
echo "║  Dann öffne den angezeigten Link im Browser und         ║"
echo "║  melde dich mit deinem Hytale-Account an.               ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# Start the server
exec java "${JAVA_ARGS[@]}" -jar "${SERVER_JAR}" "${SERVER_ARGS[@]}"
