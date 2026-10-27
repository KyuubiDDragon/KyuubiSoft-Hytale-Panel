package com.kyuubisoft.api.commands;

/**
 * How a command sent through {@link CommandRunner} ended.
 *
 * <p>The server's own dispatcher completes its future normally for an unknown
 * command, a syntax error or a missing permission, so the outcome has to be
 * determined while the command is parsed and run (see {@link CommandDispatcher}).</p>
 */
public enum CommandOutcome {
    /** Parsed, allowed and executed without an error. */
    DONE,
    /** Accepted and still running when the reply was due; it may finish later. */
    RUNNING,
    /** No command or alias with that name is registered; nothing ran. */
    NOT_FOUND,
    /** Refused before or while running: syntax, argument count, permission, or a command error message. */
    REJECTED,
    /** It started but failed with an exception. */
    FAILED;

    /** True when the command was accepted and did not fail (DONE or RUNNING). */
    public boolean ok() {
        return this == DONE || this == RUNNING;
    }
}
