#!/bin/bash
# ============================================================
# Hytale Server - Backup Post-Hook
# ============================================================
# Optional integration point for off-host backup. Invoked by backup.sh
# after a successful tarball write. The first argument is the absolute
# path of the freshly-created backup.
#
# This file ships as a no-op stub on purpose: the panel must not assume
# any particular remote backend. Replace the body with whatever fits your
# deployment. A few examples — pick one, adapt, drop the rest:
#
#   restic (encrypted, deduplicated):
#     restic -r "${RESTIC_REPOSITORY}" backup "$1"
#
#   rclone (S3 / Backblaze / Google Drive / ...):
#     rclone copy "$1" "${RCLONE_REMOTE}:hytale-backups/"
#
#   aws s3 (vanilla):
#     aws s3 cp "$1" "s3://${S3_BUCKET}/hytale-backups/"
#
#   borg (encrypted, append-only, good for cold storage):
#     borg create "${BORG_REPO}::hytale-{now}" "$1"
#
# Notes:
#   - The hook runs inside the hytale container, as the hytale user.
#     Install any CLIs you reference into the image first (Dockerfile RUN).
#   - Failures here do NOT roll back the local backup — they only log a
#     warning. If you want strict semantics, exit non-zero and add the
#     check to backup.sh.
#   - Keep secrets out of the script. Read them from env vars injected by
#     docker-compose.yml.
set -o pipefail

if [ -z "${1:-}" ] || [ ! -f "${1}" ]; then
    echo "[backup-hook] No backup path supplied or file missing; skipping."
    exit 0
fi

echo "[backup-hook] (no remote target configured) ${1}"
exit 0
