package com.kyuubisoft.api.commands;

import java.util.List;

/**
 * JSON reply of {@code POST /api/commands/execute}.
 *
 * <p>{@code ok} is true for {@code DONE} and {@code RUNNING}. {@code output}
 * holds every line the command sent back (translations resolved),
 * {@code messageIds} the translation keys of those messages, so callers can
 * react to a specific answer without parsing localized text.</p>
 */
public final class CommandResult {

    public final boolean ok;
    public final String status;
    public final String command;
    public final String sender;
    public final List<String> output;
    public final List<String> messageIds;
    public final String error;
    public final boolean truncated;
    public final long durationMs;

    CommandResult(CommandOutcome outcome, String command, String sender, PanelCommandSender.Captured captured,
                  String error, long durationMs) {
        this.ok = outcome.ok();
        this.status = outcome.name();
        this.command = command;
        this.sender = sender;
        this.output = captured.lines();
        this.messageIds = captured.messageIds();
        this.error = error;
        this.truncated = captured.truncated();
        this.durationMs = durationMs;
    }
}
