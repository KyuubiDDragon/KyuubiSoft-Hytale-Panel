#!/bin/bash
# ============================================================
# Hytale Server - Manual Backup Script
# ============================================================

BACKUP_DIR="/opt/hytale/backups"
DATA_DIR="/opt/hytale/data"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_NAME="hytale_backup_${TIMESTAMP}.tar.gz"

echo "Creating backup: ${BACKUP_NAME}"

# Create backup
tar -czf "${BACKUP_DIR}/${BACKUP_NAME}" \
    -C "${DATA_DIR}" . \
    2>/dev/null

if [ $? -eq 0 ]; then
    echo "Backup created successfully: ${BACKUP_DIR}/${BACKUP_NAME}"
    
    # Cleanup old backups (keep last 10)
    cd "${BACKUP_DIR}"
    ls -t hytale_backup_*.tar.gz 2>/dev/null | tail -n +11 | xargs -r rm
    
    echo "Cleanup complete. Keeping last 10 backups."
else
    echo "Backup failed!"
    exit 1
fi
