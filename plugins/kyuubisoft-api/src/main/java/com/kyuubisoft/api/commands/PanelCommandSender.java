package com.kyuubisoft.api.commands;

import com.hypixel.hytale.server.core.Message;
import com.hypixel.hytale.server.core.command.system.CommandSender;
import com.hypixel.hytale.server.core.console.ConsoleSender;
import com.hypixel.hytale.server.core.util.MessageUtil;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * Command sender for commands the KyuubiSoft Panel runs. It collects every
 * message a command sends back, rendered to plain text in the server's default
 * language, so the panel can show the real answer instead of "executed".
 *
 * <p>Rights: like the server console it holds every permission. The endpoint
 * that creates it is only reachable with the panel's bearer token, and the
 * panel checks its own command whitelist and the user's role before it calls
 * the endpoint. The server log names it {@code Panel:<user>}, so an operator
 * can tell panel commands apart from console input.</p>
 *
 * <p>Thread-safe: commands send messages from the common pool and the world
 * threads. After {@link #seal()} (the reply has been sent) further messages
 * are printed to the server console, so late output is not lost.</p>
 */
public final class PanelCommandSender implements CommandSender {

    static final String NAME_PREFIX = "Panel";
    static final int MAX_ACTOR_LENGTH = 48;
    static final int MAX_LINES = 500;
    static final int MAX_LINE_LENGTH = 2000;
    static final int MAX_MESSAGE_IDS = 100;

    private static final Pattern UNSAFE_ACTOR_CHARS = Pattern.compile("[^A-Za-z0-9_.@/-]");
    // C0 controls, DEL and C1 controls; tabs become spaces before this runs.
    private static final Pattern CONTROL_CHARS = Pattern.compile("[\\x00-\\x1F\\x7F-\\x9F]");
    // ANSI escape sequences a mod might put into raw text.
    private static final Pattern ANSI_ESCAPES = Pattern.compile("\\x1B\\[[0-9;?]*[ -/]*[@-~]");
    private static final Pattern LINE_BREAKS = Pattern.compile("\\r\\n|\\r|\\n|\\u2028|\\u2029");

    private final String username;
    private final UUID uuid;
    private final boolean echoToConsole;

    private final List<String> lines = new ArrayList<>();
    private final List<String> messageIds = new ArrayList<>();
    private boolean truncated;
    private boolean sealed;

    /**
     * @param actor         panel user the command runs for; sanitized, may be null
     * @param echoToConsole also print every message to the server console, as
     *                      the console sender would (for panel features that
     *                      still read the answer from the server log)
     */
    public PanelCommandSender(String actor, boolean echoToConsole) {
        String safeActor = sanitizeActor(actor);
        this.username = safeActor.isEmpty() ? NAME_PREFIX : NAME_PREFIX + ":" + safeActor;
        this.uuid = UUID.nameUUIDFromBytes(("KyuubiSoftPanel:" + username).getBytes(StandardCharsets.UTF_8));
        this.echoToConsole = echoToConsole;
    }

    /**
     * Actor reduced to a short, log-safe token: letters, digits and {@code _ . @ / -}.
     * When characters had to be replaced, a short hash of the original keeps
     * different users apart in the log ({@code J_rg-3f2a}).
     */
    static String sanitizeActor(String actor) {
        if (actor == null) return "";
        String trimmed = actor.trim();
        if (trimmed.length() > MAX_ACTOR_LENGTH) trimmed = trimmed.substring(0, MAX_ACTOR_LENGTH);
        String safe = UNSAFE_ACTOR_CHARS.matcher(trimmed).replaceAll("_");
        return safe.equals(trimmed) ? safe : safe + "-" + String.format("%04x", trimmed.hashCode() & 0xFFFF);
    }

    @Override
    public String getUsername() {
        return username;
    }

    @Override
    public UUID getUuid() {
        return uuid;
    }

    @Override
    public boolean hasPermission(String id) {
        return true;
    }

    @Override
    public boolean hasPermission(String id, boolean def) {
        return true;
    }

    @Override
    public void sendMessage(Message message) {
        if (message == null) return;
        boolean late;
        synchronized (this) {
            late = sealed;
            if (!late) collect(message);
        }
        // After the reply was sent nobody reads the capture any more: messages
        // a command sends later (download progress, results from a world
        // thread) go to the server console instead of being lost.
        if (echoToConsole || late) echo(message);
    }

    private void collect(Message message) {
        String id = message.getMessageId();
        if (id != null && messageIds.size() < MAX_MESSAGE_IDS) messageIds.add(id);
        for (String line : LINE_BREAKS.split(plainText(message), -1)) {
            addLine(line);
        }
    }

    private void addLine(String raw) {
        if (lines.size() >= MAX_LINES) {
            truncated = true;
            return;
        }
        String line = cleanLine(raw);
        if (line.length() > MAX_LINE_LENGTH) {
            line = line.substring(0, MAX_LINE_LENGTH) + "...";
            truncated = true;
        }
        lines.add(line);
    }

    /** Plain line for the panel: no ANSI escapes, no control characters, no trailing blanks. */
    static String cleanLine(String raw) {
        String noAnsi = ANSI_ESCAPES.matcher(raw).replaceAll("");
        String noTabs = noAnsi.replace('\t', ' ');
        return CONTROL_CHARS.matcher(noTabs).replaceAll("").stripTrailing();
    }

    /** Text of a message with translations resolved in the server's default language. */
    static String plainText(Message message) {
        try {
            String text = MessageUtil.formatMessageToPlainString(message.getFormattedMessage());
            if (text != null) return text;
        } catch (RuntimeException | LinkageError ignored) {
            // fall back to the console rendering below
        }
        try {
            return MessageUtil.toAnsiString(message).toString();
        } catch (RuntimeException | LinkageError ignored) {
            String raw = message.getRawText();
            return raw != null ? raw : String.valueOf(message.getMessageId());
        }
    }

    private static void echo(Message message) {
        try {
            ConsoleSender.INSTANCE.sendMessage(message);
        } catch (RuntimeException ignored) {
            // the console may not be ready during early boot; the capture still works
        }
    }

    /** Stop collecting (later messages go to the console); the reply is about to be built from {@link #snapshot()}. */
    public synchronized void seal() {
        sealed = true;
    }

    /** Copy of what was collected so far. */
    public synchronized Captured snapshot() {
        return new Captured(List.copyOf(lines), List.copyOf(messageIds), truncated);
    }

    /** Collected output: rendered lines, the top-level message ids, and whether a cap was hit. */
    public record Captured(List<String> lines, List<String> messageIds, boolean truncated) {
        boolean hasMessageIdWithPrefix(String prefix) {
            for (String id : messageIds) {
                if (id.startsWith(prefix)) return true;
            }
            return false;
        }

        /** First non-blank line, or null. */
        String firstLine() {
            for (String line : lines) {
                if (!line.isBlank()) return line;
            }
            return null;
        }
    }
}
