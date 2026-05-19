#!/bin/bash
# ============================================================
# Hytale Server - Manual Backup
# ============================================================
set -euo pipefail

BACKUP_DIR="/opt/hytale/backups"
DATA_DIR="/opt/hytale/data"
LOCK_FILE="${BACKUP_DIR}/.backup.lock"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_NAME="hytale_manual_${TIMESTAMP}.tar.gz"
RETENTION="${BACKUP_RETENTION:-10}"

mkdir -p "${BACKUP_DIR}"

# Serialize concurrent runs with flock so parallel backup requests can't corrupt
# each other's tarball or race the retention cleanup. flock(1) on the lockfile
# uses an advisory FD lock that auto-releases on script exit.
exec 9>"${LOCK_FILE}"
if ! flock -n 9; then
    echo "[INFO] Another backup is already running, waiting for lock..."
    flock 9
fi

echo "[INFO] Creating backup: ${BACKUP_NAME}"

if ! tar -czf "${BACKUP_DIR}/${BACKUP_NAME}" -C "${DATA_DIR}" . 2>/dev/null; then
    echo "[ERROR] Backup failed!"
    rm -f "${BACKUP_DIR}/${BACKUP_NAME}"
    exit 1
fi

echo "[OK] Backup created: ${BACKUP_DIR}/${BACKUP_NAME}"

# Keep only the configured number of manual backups (oldest pruned first).
# Run from BACKUP_DIR to avoid leaking absolute paths into the rm command.
cd "${BACKUP_DIR}"
if compgen -G "hytale_manual_*.tar.gz" >/dev/null; then
    ls -t hytale_manual_*.tar.gz | tail -n "+$((RETENTION + 1))" | xargs -r rm -f --
fi
echo "[OK] Cleanup complete"
