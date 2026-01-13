#!/bin/bash
# ============================================================
# Hytale Server - Entrypoint
# ============================================================

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
# Setup persistent machine-id for encrypted auth
# ============================================================
MACHINE_ID_FILE="/opt/hytale/data/.machine-id"

if [ ! -f "$MACHINE_ID_FILE" ]; then
    echo "[INFO] Generating persistent machine-id..."
    # Generate a random UUID-style machine-id
    cat /proc/sys/kernel/random/uuid | tr -d '-' > "$MACHINE_ID_FILE"
    chown hytale:hytale "$MACHINE_ID_FILE"
fi

# Link to /etc/machine-id (used by Hytale for encryption key)
if [ -f "$MACHINE_ID_FILE" ]; then
    cp "$MACHINE_ID_FILE" /etc/machine-id
    chmod 444 /etc/machine-id
    # Also setup dbus machine-id
    mkdir -p /var/lib/dbus
    cp "$MACHINE_ID_FILE" /var/lib/dbus/machine-id
    chmod 444 /var/lib/dbus/machine-id
    echo "[INFO] Machine-ID configured for auth persistence"
fi

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
    PATCHLINE="${HYTALE_PATCHLINE:-release}"
    DOWNLOAD_PATH="/opt/hytale/server/game.zip"
    
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
        
        echo "[INFO] Attempting download (attempt ${ATTEMPT})..."
        
        # Run downloader directly - output goes straight to console
        gosu hytale ./hytale-downloader-linux-amd64 -patchline "$PATCHLINE" -download-path "$DOWNLOAD_PATH" -skip-update-check
        RESULT=$?
        
        if [ $RESULT -eq 0 ] && [ -f "$DOWNLOAD_PATH" ]; then
            echo "[INFO] Download successful!"
            break
        else
            echo "[WARN] Download failed (exit code: $RESULT)"
            
            # If no credentials file exists after failure, it was an auth problem
            if [ ! -f "$CREDENTIALS_FILE" ]; then
                echo "[WARN] No credentials found - authentication may have failed"
            else
                echo "[INFO] Credentials exist - keeping them for retry (server may be overloaded)"
            fi
            
            if [ $ATTEMPT -ge $MAX_ATTEMPTS ]; then
                echo "[ERROR] Max attempts reached. Please check:"
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
                        break 2
                    fi
                    sleep 10
                done
            fi
            
            echo "[INFO] Waiting 10 seconds before retry..."
            sleep 10
        fi
    done
    
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
    echo ""
    echo "Contents of /opt/hytale/server/:"
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

# Auth credentials - symlink to persistent volume
mkdir -p /opt/hytale/auth
if [ ! -L "/opt/hytale/server/.auth" ]; then
    rm -rf /opt/hytale/server/.auth 2>/dev/null || true
    ln -sfn /opt/hytale/auth /opt/hytale/server/.auth
fi

chown -R hytale:hytale /opt/hytale

# ============================================================
# Start server
# ============================================================
echo "[INFO] Starting Hytale Server..."
echo ""
exec gosu hytale /opt/hytale/start-server.sh
