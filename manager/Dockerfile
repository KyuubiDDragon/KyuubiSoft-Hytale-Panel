# ============================================================
# Hytale Server Manager - Dockerfile
# Multi-stage build: Frontend + Backend (Node.js/TypeScript)
# ============================================================

# Node 24 LTS, pinned by multi-arch index digest so every stage builds from the
# exact same, reproducible base. To update: resolve the new digest for the tag
# (`docker buildx imagetools inspect node:24-alpine`) and bump both parts.
ARG NODE_IMAGE=node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53

# Stage 1: Build Frontend
FROM ${NODE_IMAGE} AS frontend-builder

WORKDIR /app/frontend

# Copy manifest + lockfile and install from the lockfile for reproducible builds.
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

# Copy frontend source
COPY frontend/ ./

# Build for production
RUN npm run build


# Stage 2: Build Backend
FROM ${NODE_IMAGE} AS backend-builder

# bcrypt and better-sqlite3 normally install prebuilt musl binaries; the
# toolchain is the source-build fallback for platforms without a prebuild.
RUN apk add --no-cache python3 make g++

WORKDIR /app/backend

# Copy manifest + lockfile and install from the lockfile (dev deps included for build).
COPY backend/package.json backend/package-lock.json ./
RUN npm ci

# Copy backend source
COPY backend/ ./

# Build TypeScript
RUN npm run build


# Stage 3: Production dependencies only. Installed in their own stage so the
# build toolchain never reaches the runtime image.
FROM ${NODE_IMAGE} AS backend-deps

RUN apk add --no-cache python3 make g++

WORKDIR /app/backend

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev


# Stage 4: Production Image
FROM ${NODE_IMAGE}

LABEL maintainer="Hytale Server Manager"
LABEL description="Web-based management tool for Hytale servers"

# Install wget for healthcheck, dumb-init for signal handling, gosu for user switching, unzip for asset extraction
RUN apk add --no-cache wget dumb-init gosu shadow unzip

# Create non-root user for security
# Using same UID/GID 9999 as hytale container for shared volume access
# This ensures both containers can read/write files without permission issues
RUN addgroup -g 9999 -S hytale && \
    adduser -u 9999 -S manager -G hytale

WORKDIR /app

# Manifest (needed at runtime for "type": "module") + production node_modules
# from the deps stage; same base image, so native bindings stay ABI-compatible.
COPY backend/package.json backend/package-lock.json ./
COPY --from=backend-deps /app/backend/node_modules ./node_modules

# Copy built backend from builder
COPY --from=backend-builder /app/backend/dist ./dist

# Copy assets (plugins, etc.)
COPY --from=backend-builder /app/backend/assets ./assets

# Copy frontend build from frontend builder
COPY --from=frontend-builder /app/static ./static

# Create data directory with proper ownership
RUN mkdir -p /app/data && \
    chown -R manager:hytale /app

# Copy entrypoint script
COPY --chmod=755 entrypoint.sh /app/entrypoint.sh

# Off-host backup hook. The manager writes the panel backups itself (tar on
# the shared /opt/hytale/backups volume) and runs this hook after every
# backup it creates or requests, so the hook lives in the manager image.
#
# The file lives next to this Dockerfile (manager/backup-hook.sh) because
# the build context is `./manager` and Docker won't read outside it.
# It is a byte-for-byte duplicate of scripts/backup-hook.sh; if you edit
# one, edit both. Operators normally replace the file in a derived image
# to plug in restic / rclone / borg / s3 rather than editing in place.
COPY --chmod=755 backup-hook.sh /app/backup-hook.sh

# Environment variables
ENV NODE_ENV=production
ENV MANAGER_PORT=18080

# NOTE: We start as root, then the entrypoint script drops to
# the manager user (UID 9999, same as hytale container)

# Expose port
EXPOSE 18080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD wget --quiet --tries=1 -O /dev/null http://localhost:18080/api/health || exit 1

# Use dumb-init + our entrypoint for proper signal handling and permission fixing
ENTRYPOINT ["dumb-init", "--", "/app/entrypoint.sh"]

# Run the application
CMD ["node", "dist/index.js"]
