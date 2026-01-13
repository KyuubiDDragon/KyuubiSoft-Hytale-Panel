# ============================================================
# Hytale Dedicated Server - Docker Image
# Fully automated - downloads server files on first start
# ============================================================

FROM eclipse-temurin:25-jdk-noble

LABEL maintainer="Andy - Kyuubi D. Dragon"
LABEL description="Hytale Dedicated Server - Auto-Setup"
LABEL version="2.0"

# ============================================================
# Environment Variables
# ============================================================
ENV JAVA_MIN_RAM="3G" \
    JAVA_MAX_RAM="4G" \
    SERVER_PORT="5520" \
    SERVER_BIND="0.0.0.0" \
    ENABLE_BACKUP="true" \
    BACKUP_FREQUENCY="30" \
    TZ="Europe/Berlin" \
    # Option 1: Direct URLs to server files
    SERVER_JAR_URL="" \
    ASSETS_URL="" \
    # Option 2: Use official Hytale Downloader
    USE_HYTALE_DOWNLOADER="false" \
    HYTALE_PATCHLINE="release"

# ============================================================
# Install dependencies
# ============================================================
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    wget \
    unzip \
    jq \
    tzdata \
    gosu \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && ln -snf /usr/share/zoneinfo/$TZ /etc/localtime \
    && echo $TZ > /etc/timezone

# ============================================================
# Create user and directories
# ============================================================
# Use UID 9999 to avoid conflicts with existing users
RUN groupadd -g 9999 hytale \
    && useradd -u 9999 -g hytale -m -s /bin/bash hytale \
    && mkdir -p /opt/hytale/server \
                /opt/hytale/data \
                /opt/hytale/backups \
                /opt/hytale/plugins \
                /opt/hytale/mods \
                /opt/hytale/logs \
                /opt/hytale/downloader \
    && chown -R hytale:hytale /opt/hytale

WORKDIR /opt/hytale

# ============================================================
# Copy scripts
# ============================================================
COPY --chmod=755 scripts/entrypoint.sh /opt/hytale/entrypoint.sh
COPY --chmod=755 scripts/start-server.sh /opt/hytale/start-server.sh
COPY --chmod=755 scripts/backup.sh /opt/hytale/backup.sh

# ============================================================
# Volumes for persistent data
# ============================================================
VOLUME ["/opt/hytale/data", "/opt/hytale/backups", "/opt/hytale/plugins", "/opt/hytale/mods", "/opt/hytale/server", "/opt/hytale/downloader"]

# ============================================================
# Expose UDP port (QUIC protocol)
# ============================================================
EXPOSE 5520/udp

# ============================================================
# Health check
# ============================================================
HEALTHCHECK --interval=60s --timeout=10s --start-period=180s --retries=3 \
    CMD pgrep -f "HytaleServer.jar" > /dev/null || exit 1

ENTRYPOINT ["/opt/hytale/entrypoint.sh"]
