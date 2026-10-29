package com.kyuubisoft.api.live;

import com.hypixel.hytale.server.core.Message;
import com.hypixel.hytale.server.core.universe.PlayerRef;
import com.hypixel.hytale.server.core.universe.Universe;
import com.hypixel.hytale.server.core.util.MessageUtil;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Locale;
import java.util.UUID;

/** Small conversions shared by the data collectors. */
final class LiveFormat {

    private static final int MAX_TEXT_LENGTH = 500;

    private LiveFormat() {
    }

    static String iso(Instant instant) {
        return instant == null ? null : instant.toString();
    }

    static String uuid(UUID uuid) {
        return uuid == null ? null : uuid.toString();
    }

    static String lower(Enum<?> value) {
        return value == null ? null : value.name().toLowerCase(Locale.ROOT);
    }

    /** Plain text of a server message (translations resolved as the console shows them). */
    static String text(Message message) {
        if (message == null) return null;
        try {
            String plain = MessageUtil.toAnsiString(message).toString();
            if (plain != null && !plain.isBlank()) return clip(plain);
        } catch (Throwable ignored) {
            // Fall through to the raw text / message id below.
        }
        String raw = message.getRawText();
        if (raw != null && !raw.isBlank()) return clip(raw);
        return message.getMessageId();
    }

    static String clip(String value) {
        if (value == null) return null;
        String trimmed = value.strip();
        return trimmed.length() <= MAX_TEXT_LENGTH ? trimmed : trimmed.substring(0, MAX_TEXT_LENGTH);
    }

    /** Name of an online player, or null when the player is offline. */
    static String onlineName(UUID uuid) {
        if (uuid == null) return null;
        try {
            PlayerRef ref = Universe.get().getPlayer(uuid);
            return ref == null ? null : ref.getUsername();
        } catch (Throwable t) {
            return null;
        }
    }

    static List<String> sorted(Collection<String> values) {
        List<String> list = new ArrayList<>(values == null ? List.of() : values);
        list.sort(String.CASE_INSENSITIVE_ORDER);
        return list;
    }

    static double round2(double value) {
        return Math.round(value * 100.0) / 100.0;
    }
}
