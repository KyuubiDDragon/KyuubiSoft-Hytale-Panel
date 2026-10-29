#!/bin/sh
# ============================================================
# Hytale Server - Container Health Check
# ============================================================
# Healthy = a java process is running AND a socket is bound to the game's UDP
# port. Matching the process name instead of the command line keeps the check
# from finding its own shell, and also covers alternative launcher jars.

pgrep -x java > /dev/null || exit 1

# /proc/net/udp and udp6 list the sockets of the container's network
# namespace; the second column is the local address, ending in ":<port as
# 4-digit hex>".
port_hex=$(printf '%04X' "${SERVER_PORT:-5520}") || exit 1
set --
for table in /proc/net/udp /proc/net/udp6; do
    [ -r "$table" ] && set -- "$@" "$table"
done
[ "$#" -gt 0 ] || exit 1

awk -v port=":${port_hex}" '
    FNR > 1 && toupper(substr($2, length($2) - 4)) == port { found = 1 }
    END { exit !found }
' "$@"
