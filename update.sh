#!/bin/bash
# ============================================================
# Hytale Server - Update Helper
# Hilft beim Aktualisieren des Servers
# ============================================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo -e "${GREEN}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║           Hytale Server - Update Helper                  ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════╝${NC}"
echo ""

# Check if docker-compose is running
if docker-compose ps | grep -q "Up"; then
    echo -e "${YELLOW}[WARN]${NC} Server läuft noch. Stoppe Server..."
    docker-compose down
    echo -e "${GREEN}[OK]${NC} Server gestoppt"
fi

echo ""
echo "Bitte gib den Pfad zu deiner Hytale-Installation an:"
echo "(z.B. /home/user/Hytale oder C:\\Users\\User\\Hytale)"
read -p "Pfad: " HYTALE_PATH

# Normalize path
HYTALE_PATH="${HYTALE_PATH%/}"

# Find server files
SERVER_JAR=""
ASSETS_ZIP=""

# Try different possible locations
POSSIBLE_PATHS=(
    "${HYTALE_PATH}/install/release/package/game/latest/Server/HytaleServer.jar"
    "${HYTALE_PATH}/Server/HytaleServer.jar"
    "${HYTALE_PATH}/HytaleServer.jar"
)

for path in "${POSSIBLE_PATHS[@]}"; do
    if [ -f "$path" ]; then
        SERVER_JAR="$path"
        break
    fi
done

ASSET_PATHS=(
    "${HYTALE_PATH}/install/release/package/game/latest/Assets.zip"
    "${HYTALE_PATH}/Assets.zip"
)

for path in "${ASSET_PATHS[@]}"; do
    if [ -f "$path" ]; then
        ASSETS_ZIP="$path"
        break
    fi
done

if [ -z "$SERVER_JAR" ]; then
    echo -e "${RED}[ERROR]${NC} HytaleServer.jar nicht gefunden!"
    echo "Bitte stelle sicher, dass der Pfad korrekt ist."
    exit 1
fi

if [ -z "$ASSETS_ZIP" ]; then
    echo -e "${RED}[ERROR]${NC} Assets.zip nicht gefunden!"
    exit 1
fi

echo ""
echo -e "${GREEN}[OK]${NC} Gefunden:"
echo "  - Server JAR: $SERVER_JAR"
echo "  - Assets: $ASSETS_ZIP"
echo ""

# Create backup of current server files
if [ -f "./server/HytaleServer.jar" ]; then
    echo -e "${YELLOW}[INFO]${NC} Erstelle Backup der alten Server-Dateien..."
    mkdir -p ./server_backup
    cp ./server/HytaleServer.jar ./server_backup/HytaleServer.jar.bak 2>/dev/null || true
fi

# Copy new files
echo -e "${GREEN}[INFO]${NC} Kopiere neue Server-Dateien..."
mkdir -p ./server
cp "$SERVER_JAR" ./server/
cp "$ASSETS_ZIP" ./server/

# Also copy AOT cache if available
AOT_DIR="$(dirname "$SERVER_JAR")"
if [ -f "${AOT_DIR}/HytaleServer.aot" ]; then
    cp "${AOT_DIR}/HytaleServer.aot" ./server/
    echo -e "${GREEN}[OK]${NC} AOT Cache kopiert (schnellerer Start)"
fi

echo ""
echo -e "${GREEN}[OK]${NC} Server-Dateien aktualisiert!"
echo ""

read -p "Soll der Server jetzt neu gestartet werden? (j/n): " START_SERVER

if [ "$START_SERVER" = "j" ] || [ "$START_SERVER" = "J" ]; then
    echo -e "${GREEN}[INFO]${NC} Baue Docker-Image und starte Server..."
    docker-compose up -d --build
    echo ""
    echo -e "${GREEN}[OK]${NC} Server gestartet!"
    echo ""
    echo "Logs anschauen: docker-compose logs -f"
    echo "Console öffnen: docker attach hytale-server"
else
    echo ""
    echo "Server kann später mit 'docker-compose up -d' gestartet werden."
fi
