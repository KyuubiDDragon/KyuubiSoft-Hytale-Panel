package com.kyuubisoft.api.panel.internal;

import java.lang.reflect.Array;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.logging.Logger;

/**
 * {@code mod_event} delivery: id checks, payload trimming and a per-mod rate limit, then out
 * through the WebSocket broadcaster. Internal; mods use
 * {@link com.kyuubisoft.api.panel.PanelRegistry#publishEvent}.
 */
public final class ModEvents {

    private static final Logger LOGGER = Logger.getLogger("KyuubiSoftAPI");

    static final double EVENTS_PER_SECOND = 20;
    static final double BURST = 40;
    static final int MAX_DEPTH = 4;
    static final int MAX_ENTRIES = 50;
    static final int MAX_TEXT = 1_000;
    static final int MAX_NODES = 2_000;
    static final int MAX_TOTAL_TEXT = 32_000;
    private static final int MAX_KEY = 64;
    private static final int MAX_SOURCES = 256;
    private static final long DROP_LOG_INTERVAL_MS = 60_000;

    private static final Map<String, Bucket> BUCKETS = new ConcurrentHashMap<>();

    private ModEvents() {}

    public static boolean publish(String modId, String type, Map<String, ?> payload) {
        if (!PanelWire.isValidProviderId(modId) || !PanelWire.isValidName(type)) {
            LOGGER.fine("mod_event rejected: invalid modId or type (" + PanelWire.clip(modId, 64) + ")");
            return false;
        }
        PanelRuntime runtime = PanelRuntime.current();
        if (runtime == null || runtime.broadcaster() == null) return false;
        Bucket bucket = bucket(modId);
        if (bucket == null || !bucket.tryTake()) return false;
        try {
            runtime.broadcaster().broadcastModEvent(modId, type, sanitizeMap(payload, 1));
            return true;
        } catch (RuntimeException e) {
            LOGGER.fine("mod_event from " + modId + " could not be sent: " + e.getMessage());
            return false;
        }
    }

    private static Bucket bucket(String modId) {
        Bucket bucket = BUCKETS.get(modId);
        if (bucket != null) return bucket;
        // A fixed set of sources in practice; the cap only guards against a mod inventing ids.
        if (BUCKETS.size() >= MAX_SOURCES) return null;
        return BUCKETS.computeIfAbsent(modId, Bucket::new);
    }

    /** JSON-friendly copy: null/Boolean/Number/String, maps and lists, trimmed to the limits. */
    static Map<String, Object> sanitizeMap(Map<?, ?> map, int depth) {
        return sanitizeMap(map, depth, new Budget());
    }

    private static Map<String, Object> sanitizeMap(Map<?, ?> map, int depth, Budget budget) {
        Map<String, Object> out = new LinkedHashMap<>();
        if (map == null) return out;
        for (Map.Entry<?, ?> entry : map.entrySet()) {
            if (out.size() >= MAX_ENTRIES || !budget.take(0)) break;
            if (entry.getKey() == null) continue;
            String key = PanelWire.clip(String.valueOf(entry.getKey()), MAX_KEY);
            Object value = sanitize(entry.getValue(), depth, budget);
            if (budget.exhausted()) break;
            out.put(key, value);
        }
        return out;
    }

    static Object sanitize(Object value, int depth) {
        return sanitize(value, depth, new Budget());
    }

    private static Object sanitize(Object value, int depth, Budget budget) {
        if (value == null || value instanceof Boolean) return value;
        if (value instanceof Number number) {
            double d = number.doubleValue();
            return Double.isNaN(d) || Double.isInfinite(d) ? number.toString() : number;
        }
        if (value instanceof CharSequence text) return budget.text(PanelWire.clip(text.toString(), MAX_TEXT));
        if (value instanceof Enum<?> e) return e.name();
        if (value instanceof Map<?, ?> map) return depth >= MAX_DEPTH ? null : sanitizeMap(map, depth + 1, budget);
        if (value instanceof Iterable<?> items) {
            if (depth >= MAX_DEPTH) return null;
            List<Object> out = new ArrayList<>();
            for (Object item : items) {
                if (out.size() >= MAX_ENTRIES || !budget.take(0)) break;
                Object element = sanitize(item, depth + 1, budget);
                if (budget.exhausted()) break;
                out.add(element);
            }
            return out;
        }
        if (value.getClass().isArray()) {
            if (depth >= MAX_DEPTH) return null;
            int length = Math.min(Array.getLength(value), MAX_ENTRIES);
            List<Object> out = new ArrayList<>(length);
            for (int i = 0; i < length && budget.take(0); i++) {
                Object element = sanitize(Array.get(value, i), depth + 1, budget);
                if (budget.exhausted()) break;
                out.add(element);
            }
            return out;
        }
        return budget.text(PanelWire.clip(String.valueOf(value), MAX_TEXT));
    }

    /**
     * Limits a whole payload, not only each level: at most {@link #MAX_NODES}
     * values and {@link #MAX_TOTAL_TEXT} characters of text per event. What
     * does not fit is left out.
     */
    private static final class Budget {
        private int nodes;
        private int chars;
        private boolean exhausted;

        /** Count one value of {@code length} text characters; false once the payload is full. */
        boolean take(int length) {
            if (exhausted) return false;
            if (nodes + 1 > MAX_NODES || chars + length > MAX_TOTAL_TEXT) {
                exhausted = true;
                return false;
            }
            nodes++;
            chars += length;
            return true;
        }

        String text(String value) {
            return take(value.length()) ? value : null;
        }

        boolean exhausted() {
            return exhausted;
        }
    }

    /** Token bucket: {@link #EVENTS_PER_SECOND} on average, bursts up to {@link #BURST}. */
    static final class Bucket {
        private final String modId;
        private double tokens = BURST;
        private long refilledAt = System.nanoTime();
        private long lastDropLog;

        Bucket(String modId) {
            this.modId = modId;
        }

        synchronized boolean tryTake() {
            long now = System.nanoTime();
            tokens = Math.min(BURST, tokens + (now - refilledAt) / 1e9 * EVENTS_PER_SECOND);
            refilledAt = now;
            if (tokens >= 1) {
                tokens -= 1;
                return true;
            }
            long nowMs = System.currentTimeMillis();
            if (nowMs - lastDropLog >= DROP_LOG_INTERVAL_MS) {
                lastDropLog = nowMs;
                LOGGER.warning("mod_event rate limit hit by " + modId + ", dropping events"
                        + " (logged at most once per minute)");
            }
            return false;
        }
    }
}
