#!/bin/bash
# ============================================================
# Hytale Server - Health Check Script
# ============================================================

# Check if Java process is running
if pgrep -f "HytaleServer.jar" > /dev/null; then
    exit 0
else
    exit 1
fi
