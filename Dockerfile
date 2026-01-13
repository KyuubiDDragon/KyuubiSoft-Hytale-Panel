# ============================================================
# Hytale Dedicated Server - Docker Image
# Author: Andy (RamgeSoft)
# Date: 2026-01-13
# ============================================================

FROM eclipse-temurin:25-jdk-noble

LABEL maintainer="Andy <andy@ramgesoft.com>"
LABEL description="Hytale Dedicated Server"
LABEL version="1.0"

# ============================================================
# Environment Variables (can be overridden in docker-compose)
# ============================================================
ENV JAVA_MIN_RAM="3G" \
    JAVA_MAX_RAM="4G" \
    SERVER_PORT="5520" \
    SERVER_BIND="0.0.0.0" \
    ENABLE_BACKUP="true" \
    BACKUP_FREQUENCY="30" \
    VIEW_DISTANCE="12" \
    TZ="Europe/Berlin" \
    PUID=1000 \
    PGID=1000

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
    && rm -rf /var/lib/apt/lists/* \
    && ln -snf /usr/share/zoneinfo/$TZ /etc/localtime \
    && echo $TZ > /etc/timezone

# ============================================================
# Create hytale user and directories
# ============================================================
RUN groupadd -g ${PGID} hytale \
    && useradd -u ${PUID} -g hytale -m -s /bin/bash hytale

# Server directories
RUN mkdir -p /opt/hytale/server \
    /opt/hytale/data \
    /opt/hytale/backups \
    /opt/hytale/plugins \
    /opt/hytale/mods \
    /opt/hytale/logs \
    && chown -R hytale:hytale /opt/hytale

WORKDIR /opt/hytale/server

# ============================================================
# Copy scripts
# ============================================================
COPY --chown=hytale:hytale scripts/entrypoint.sh /opt/hytale/entrypoint.sh
COPY --chown=hytale:hytale scripts/start-server.sh /opt/hytale/start-server.sh
COPY --chown=hytale:hytale scripts/backup.sh /opt/hytale/backup.sh
COPY --chown=hytale:hytale scripts/healthcheck.sh /opt/hytale/healthcheck.sh

RUN chmod +x /opt/hytale/*.sh

# ============================================================
# Volumes
# ============================================================
VOLUME ["/opt/hytale/data", "/opt/hytale/backups", "/opt/hytale/plugins", "/opt/hytale/mods"]

# ============================================================
# Expose UDP port (QUIC protocol!)
# ============================================================
EXPOSE ${SERVER_PORT}/udp

# ============================================================
# Health check
# ============================================================
HEALTHCHECK --interval=60s --timeout=10s --start-period=120s --retries=3 \
    CMD /opt/hytale/healthcheck.sh || exit 1

# ============================================================
# Entrypoint
# ============================================================
ENTRYPOINT ["/opt/hytale/entrypoint.sh"]
