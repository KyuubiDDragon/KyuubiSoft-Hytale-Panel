package com.kyuubisoft.api.live;

import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Join time per online player, recorded from the connect/disconnect events.
 * Players that were already online when the plugin started have no entry
 * (their join time is unknown, reported as absent rather than "now").
 */
public final class SessionTracker {

    private final Map<UUID, Instant> joinedAt = new ConcurrentHashMap<>();

    public void onJoin(UUID uuid) {
        if (uuid != null) joinedAt.put(uuid, Instant.now());
    }

    public void onLeave(UUID uuid) {
        if (uuid != null) joinedAt.remove(uuid);
    }

    public Instant joinedAt(UUID uuid) {
        return uuid == null ? null : joinedAt.get(uuid);
    }
}
