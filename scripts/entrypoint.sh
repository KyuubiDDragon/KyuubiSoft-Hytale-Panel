#!/bin/bash
# ============================================================
# Hytale Server - Entrypoint Script
# Handles initialization, permissions, and server startup
# ============================================================

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_header() {
    echo -e "${BLUE}============================================================${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}============================================================${NC}"
}

# ============================================================
# Banner
# ============================================================
log_header "Hytale Dedicated Server - Docker Container"
echo ""
echo "  Java Version: $(java -version 2>&1 | head -n 1)"
echo "  RAM: ${JAVA_MIN_RAM} - ${JAVA_MAX_RAM}"
echo "  Port: ${SERVER_BIND}:${SERVER_PORT}/udp"
echo "  Timezone: ${TZ}"
echo ""

# ============================================================
# Check for server files
# ============================================================
log_info "Checking for server files..."

SERVER_JAR="/opt/hytale/server/HytaleServer.jar"
ASSETS_FILE="/opt/hytale/server/Assets.zip"

if [ ! -f "$SERVER_JAR" ]; then
    log_error "HytaleServer.jar not found!"
    log_error "Please mount your server files to /opt/hytale/server"
    log_error ""
    log_error "You can get the server files by:"
    log_error "1. Copying from your Hytale installation (Server folder + Assets.zip)"
    log_error "2. Using the official hytale-downloader tool"
    log_error ""
    log_error "Expected files:"
    log_error "  - /opt/hytale/server/HytaleServer.jar"
    log_error "  - /opt/hytale/server/Assets.zip"
    exit 1
fi

if [ ! -f "$ASSETS_FILE" ]; then
    log_error "Assets.zip not found!"
    log_error "The server requires Assets.zip to run."
    log_error "Please copy it from your Hytale installation."
    exit 1
fi

log_info "Server files found!"

# ============================================================
# Check for AOT cache (improves boot time)
# ============================================================
AOT_CACHE="/opt/hytale/server/HytaleServer.aot"
AOT_FLAG=""
if [ -f "$AOT_CACHE" ]; then
    log_info "AOT cache found - enabling fast startup"
    AOT_FLAG="-XX:AOTCache=HytaleServer.aot"
fi

# ============================================================
# Create symlinks for data persistence
# ============================================================
log_info "Setting up data directories..."

# Link universe (worlds) to data volume
if [ ! -L "/opt/hytale/server/universe" ] && [ -d "/opt/hytale/server/universe" ]; then
    log_info "Moving existing universe to data volume..."
    mv /opt/hytale/server/universe/* /opt/hytale/data/ 2>/dev/null || true
    rm -rf /opt/hytale/server/universe
fi
mkdir -p /opt/hytale/data/worlds
ln -sfn /opt/hytale/data /opt/hytale/server/universe

# Link plugins
mkdir -p /opt/hytale/plugins
ln -sfn /opt/hytale/plugins /opt/hytale/server/plugins 2>/dev/null || true

# Link mods
mkdir -p /opt/hytale/mods
ln -sfn /opt/hytale/mods /opt/hytale/server/mods 2>/dev/null || true

# ============================================================
# Fix permissions
# ============================================================
log_info "Fixing permissions..."
chown -R hytale:hytale /opt/hytale

# ============================================================
# Export variables for start script
# ============================================================
export SERVER_JAR
export ASSETS_FILE
export AOT_FLAG

# ============================================================
# Start the server
# ============================================================
log_info "Starting Hytale server..."
exec gosu hytale /opt/hytale/start-server.sh
