#!/bin/bash
# ============================================================
# Hytale Server - Entrypoint
# ============================================================

set -e

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
chown -R hytale:hytale /opt/hytale

# ============================================================
# Check/Download server files
# ============================================================
echo "[INFO] Checking server files..."

SERVER_JAR="/opt/hytale/server/HytaleServer.jar"
ASSETS_FILE="/opt/hytale/server/Assets.zip"
DOWNLOADER_DIR="/opt/hytale/downloader"
CREDENTIALS_FILE="${DOWNLOADER_DIR}/.hytale-downloader-credentials.json"

# If files exist, skip download
if [ -f "$SERVER_JAR" ] && [ -f "$ASSETS_FILE" ]; then
    echo "[INFO] Server files found!"
    
# Option 1: Download URLs provided
elif [ -n "$SERVER_JAR_URL" ] && [ -n "$ASSETS_URL" ]; then
    echo "[INFO] Downloading server files from URLs..."
    
    if [ ! -f "$SERVER_JAR" ]; then
        echo "[INFO] Downloading HytaleServer.jar..."
        gosu hytale wget -q --show-progress -O "$SERVER_JAR" "$SERVER_JAR_URL"
    fi
    
    if [ ! -f "$ASSETS_FILE" ]; then
        echo "[INFO] Downloading Assets.zip (~3GB)..."
        gosu hytale wget -q --show-progress -O "$ASSETS_FILE" "$ASSETS_URL"
    fi
    
    echo "[INFO] Download complete!"

# Option 2: Use official Hytale Downloader
elif [ "$USE_HYTALE_DOWNLOADER" = "true" ]; then
    echo "[INFO] Using official Hytale Downloader..."
    
    mkdir -p "$DOWNLOADER_DIR"
    chown hytale:hytale "$DOWNLOADER_DIR"
    
    # Download the downloader tool
    DOWNLOADER_BIN="${DOWNLOADER_DIR}/hytale-downloader-linux-amd64"
    
    if [ ! -f "$DOWNLOADER_BIN" ]; then
        echo "[INFO] Downloading Hytale Downloader from official source..."
        cd "$DOWNLOADER_DIR"
        gosu hytale wget -q --show-progress -O hytale-downloader.zip "https://downloader.hytale.com/hytale-downloader.zip"
        gosu hytale unzip -o hytale-downloader.zip
        chmod +x hytale-downloader-linux-amd64 2>/dev/null || true
        rm -f hytale-downloader.zip
    fi
    
    cd "$DOWNLOADER_DIR"
    
    # Check if we have credentials
    if [ ! -f "$CREDENTIALS_FILE" ]; then
        echo ""
        echo "╔══════════════════════════════════════════════════════════╗"
        echo "║  AUTHENTICATION REQUIRED                                 ║"
        echo "╠══════════════════════════════════════════════════════════╣"
        echo "║  Running Hytale Downloader for first-time setup...       ║"
        echo "║  A URL and code will appear below.                       ║"
        echo "║  Open the URL in your browser and enter the code.        ║"
        echo "╚══════════════════════════════════════════════════════════╝"
        echo ""
    fi
    
    # Run downloader
    PATCHLINE="${HYTALE_PATCHLINE:-release}"
    DOWNLOAD_PATH="/opt/hytale/server/game.zip"
    
    echo "[INFO] Downloading game files (patchline: ${PATCHLINE})..."
    gosu hytale ./hytale-downloader-linux-amd64 -patchline "$PATCHLINE" -download-path "$DOWNLOAD_PATH" -skip-update-check
    
    # Extract the downloaded zip
    if [ -f "$DOWNLOAD_PATH" ]; then
        echo "[INFO] Extracting game files..."
        cd /opt/hytale/server
        gosu hytale unzip -o game.zip
        
        # Move files to correct locations
        if [ -d "Server" ]; then
            mv Server/* . 2>/dev/null || true
            rm -rf Server
        fi
        
        rm -f game.zip
        echo "[INFO] Extraction complete!"
    else
        echo "[ERROR] Download failed - game.zip not found"
        exit 1
    fi

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
        sleep 5
    done
fi

# ============================================================
# Final check
# ============================================================
if [ ! -f "$SERVER_JAR" ] || [ ! -f "$ASSETS_FILE" ]; then
    echo "[ERROR] Server files still missing!"
    echo "[ERROR] Expected: $SERVER_JAR"
    echo "[ERROR] Expected: $ASSETS_FILE"
    ls -la /opt/hytale/server/ || true
    exit 1
fi

echo "[INFO] Server files verified!"

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

chown -R hytale:hytale /opt/hytale

# ============================================================
# Start server
# ============================================================
echo "[INFO] Starting Hytale Server..."
echo ""
exec gosu hytale /opt/hytale/start-server.sh
