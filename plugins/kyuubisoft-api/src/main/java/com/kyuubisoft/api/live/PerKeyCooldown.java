package com.kyuubisoft.api.live;

import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Lets one event per key through per window (keys compared case-insensitively).
 * Bounded: once {@code maxKeys} keys are inside their window, unknown keys are
 * refused until older entries expire, so made-up keys cannot grow the map or
 * flood the panel. Thread-safe.
 */
final class PerKeyCooldown {

    private final long windowMs;
    private final int maxKeys;
    private final Map<String, Long> lastAccepted = new ConcurrentHashMap<>();

    PerKeyCooldown(long windowMs, int maxKeys) {
        this.windowMs = windowMs;
        this.maxKeys = maxKeys;
    }

    /** True when {@code key} may pass at {@code nowMs}; a null key counts as one shared key. */
    boolean tryAcquire(String key, long nowMs) {
        String normalized = key == null ? "" : key.toLowerCase(Locale.ROOT);
        Long last = lastAccepted.get(normalized);
        if (last != null && nowMs - last < windowMs) return false;
        if (last == null && lastAccepted.size() >= maxKeys) {
            lastAccepted.values().removeIf(at -> nowMs - at >= windowMs);
            if (lastAccepted.size() >= maxKeys) return false;
        }
        // Two threads racing for the same key: only the one that wins the replace passes.
        return last == null
                ? lastAccepted.putIfAbsent(normalized, nowMs) == null
                : lastAccepted.replace(normalized, last, nowMs);
    }
}
