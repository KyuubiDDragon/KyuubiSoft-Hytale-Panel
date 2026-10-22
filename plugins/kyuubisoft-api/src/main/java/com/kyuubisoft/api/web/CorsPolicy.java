package com.kyuubisoft.api.web;

import io.netty.handler.codec.http.HttpHeaderNames;
import io.netty.handler.codec.http.HttpHeaders;

import java.util.Collection;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Set;
import java.util.logging.Logger;

/**
 * Explicit CORS allowlist. CORS is off by default: without listed origins no
 * Access-Control-* headers are sent, so browsers on other sites cannot read
 * API responses. Wildcards are rejected because every route needs the token.
 */
public final class CorsPolicy {

    private static final Logger LOGGER = Logger.getLogger("KyuubiSoftAPI");

    private final Set<String> allowedOrigins;

    public CorsPolicy(Collection<String> origins) {
        Set<String> allowed = new LinkedHashSet<>();
        if (origins != null) {
            for (String origin : origins) {
                String normalized = normalize(origin);
                if (normalized != null) {
                    allowed.add(normalized);
                } else {
                    LOGGER.warning("Ignoring CORS origin '" + origin + "': only explicit origins like https://panel.example.com are allowed.");
                }
            }
        }
        this.allowedOrigins = Collections.unmodifiableSet(allowed);
        if (!allowedOrigins.isEmpty()) {
            LOGGER.info("CORS enabled for: " + String.join(", ", allowedOrigins));
        }
    }

    /** Lower-cased origin without trailing slash, or null for blank, "*" and "null". */
    static String normalize(String origin) {
        if (origin == null) return null;
        String value = origin.trim();
        while (value.endsWith("/")) {
            value = value.substring(0, value.length() - 1);
        }
        if (value.isEmpty() || value.equals("*") || value.equalsIgnoreCase("null")) return null;
        return value.toLowerCase(Locale.ROOT);
    }

    /** True if the request's Origin header names an allow-listed origin. */
    public boolean isAllowed(String origin) {
        String normalized = normalize(origin);
        return normalized != null && allowedOrigins.contains(normalized);
    }

    /** Adds CORS headers for an allow-listed origin; leaves the headers untouched otherwise. */
    public void apply(HttpHeaders headers, String origin) {
        if (!isAllowed(origin)) return;
        headers.set(HttpHeaderNames.ACCESS_CONTROL_ALLOW_ORIGIN, origin.trim());
        headers.add(HttpHeaderNames.VARY, HttpHeaderNames.ORIGIN);
        headers.set(HttpHeaderNames.ACCESS_CONTROL_ALLOW_METHODS, "GET, POST, OPTIONS");
        headers.set(HttpHeaderNames.ACCESS_CONTROL_ALLOW_HEADERS, "Content-Type, Authorization");
    }
}
