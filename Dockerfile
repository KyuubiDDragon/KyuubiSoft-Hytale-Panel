# ============================================================
# Hytale Dedicated Server - Docker Image
# Fully automated - downloads server files on first start
# ============================================================

# Java runtime only (JRE): the server needs no JDK tools. Pinned by multi-arch
# index digest (tag 25-jre-noble = 25.0.4.1_1-jre-noble at pin time). To update:
# `docker buildx imagetools inspect eclipse-temurin:25-jre-noble`.
# Plugins that need JDK-only modules (e.g. jdk.attach for agents that attach
# themselves at runtime) can build on the JDK image instead:
#   docker compose build --build-arg JAVA_IMAGE=eclipse-temurin:25-jdk-noble
ARG JAVA_IMAGE=eclipse-temurin:25-jre-noble@sha256:3f2223fe04b750aa5a8179e29b5c9a1ddf7665fc9bb08bfe11ad01d143bc13a5
FROM ${JAVA_IMAGE}

# Release builds pass the panel version (`--build-arg IMAGE_VERSION=...`); a
# hard-coded value here only goes stale.
ARG IMAGE_VERSION=dev
LABEL maintainer="Andy - Kyuubi D. Dragon"
LABEL description="Hytale Dedicated Server - Auto-Setup"
LABEL org.opencontainers.image.version="${IMAGE_VERSION}"

# ============================================================
# Environment Variables
# ============================================================
ENV JAVA_MIN_RAM="3G" \
    JAVA_MAX_RAM="4G" \
    SERVER_PORT="5520" \
    SERVER_BIND="0.0.0.0" \
    ENABLE_BACKUP="false" \
    BACKUP_FREQUENCY="30" \
    TZ="Europe/Berlin" \
    # Option 1: Direct URLs to server files
    SERVER_JAR_URL="" \
    ASSETS_URL="" \
    # Option 2: Use official Hytale Downloader
    USE_HYTALE_DOWNLOADER="false" \
    HYTALE_PATCHLINE="release" \
    # Auto-update on container restart
    AUTO_UPDATE="false"

# ============================================================
# Install dependencies
# ============================================================
# wget: downloads, unzip: server/downloader archives, procps: pgrep for the
# healthcheck, gosu: drop from root to the hytale user.
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget \
    unzip \
    jq \
    procps \
    tzdata \
    gosu \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# Note: Timezone is set at runtime in entrypoint.sh using TZ env variable

# ============================================================
# Create user and directories
# ============================================================
# Use UID 9999 to avoid conflicts with existing users
RUN groupadd -g 9999 hytale \
    && useradd -u 9999 -g hytale -m -s /bin/bash hytale \
    && mkdir -p /opt/hytale/server \
                /opt/hytale/updater \
                /opt/hytale/data \
                /opt/hytale/backups \
                /opt/hytale/earlyplugins \
                /opt/hytale/plugins \
                /opt/hytale/mods \
                /opt/hytale/downloader \
                /opt/hytale/auth \
    && chown -R hytale:hytale /opt/hytale \
    && chown root:root /opt/hytale
# /opt/hytale itself stays root's: it holds the scripts that run as root at
# every start, and whoever can write a directory can replace the files in it.
# The server only writes inside the subdirectories.

WORKDIR /opt/hytale

# ============================================================
# Copy scripts
# ============================================================
COPY --chmod=755 scripts/entrypoint.sh /opt/hytale/entrypoint.sh
COPY --chmod=755 scripts/start-server.sh /opt/hytale/start-server.sh
COPY --chmod=644 scripts/start-args.sh /opt/hytale/start-args.sh
COPY --chmod=755 scripts/healthcheck.sh /opt/hytale/healthcheck.sh

# ============================================================
# Volumes for persistent data
# ============================================================
VOLUME ["/opt/hytale/data", "/opt/hytale/backups", "/opt/hytale/earlyplugins", "/opt/hytale/plugins", "/opt/hytale/mods", "/opt/hytale/server", "/opt/hytale/downloader", "/opt/hytale/auth", "/opt/hytale/updater"]

# ============================================================
# Expose UDP port (QUIC protocol)
# ============================================================
EXPOSE 5520/udp

# ============================================================
# Health check
# ============================================================
# Healthy only while a java process runs AND the game's UDP port is bound
# (scripts/healthcheck.sh). The start period covers the first boot of a large
# world; while the server files are still being downloaded the container is
# reported unhealthy, which is accurate (the manager only waits for
# service_started).
HEALTHCHECK --interval=30s --timeout=5s --start-period=300s --retries=3 \
    CMD ["/opt/hytale/healthcheck.sh"]

ENTRYPOINT ["/opt/hytale/entrypoint.sh"]
