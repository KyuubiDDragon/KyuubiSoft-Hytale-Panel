# ============================================================
# Hytale Server Manager - Dockerfile
# Multi-stage build: Frontend + Backend (Node.js/TypeScript)
# ============================================================

# Stage 1: Build Frontend
FROM node:20-alpine AS frontend-builder

WORKDIR /app/frontend

# Copy package files
COPY frontend/package.json ./

# Install dependencies
RUN npm install

# Copy frontend source
COPY frontend/ ./

# Build for production
RUN npm run build


# Stage 2: Build Backend
FROM node:20-alpine AS backend-builder

WORKDIR /app/backend

# Copy package files
COPY backend/package.json ./

# Install dependencies (including dev for build)
RUN npm install

# Copy backend source
COPY backend/ ./

# Build TypeScript
RUN npm run build


# Stage 3: Production Image
FROM node:20-alpine

LABEL maintainer="Hytale Server Manager"
LABEL description="Web-based management tool for Hytale servers"

# Install wget for healthcheck
RUN apk add --no-cache wget

WORKDIR /app

# Copy package files and install production dependencies only
COPY backend/package.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copy built backend from builder
COPY --from=backend-builder /app/backend/dist ./dist

# Copy assets (plugins, etc.)
COPY --from=backend-builder /app/backend/assets ./assets

# Copy frontend build from frontend builder
COPY --from=frontend-builder /app/static ./static

# Create data directory
RUN mkdir -p /app/data

# Environment variables
ENV NODE_ENV=production
ENV MANAGER_PORT=18080

# Expose port
EXPOSE 18080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD wget --quiet --tries=1 -O /dev/null http://localhost:18080/api/health || exit 1

# Run the application
CMD ["node", "dist/index.js"]
