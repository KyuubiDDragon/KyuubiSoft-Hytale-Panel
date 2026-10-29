package com.kyuubisoft.api.web;

/**
 * A request failure with a specific HTTP status and a message that is safe to
 * show to the client. Throw it from a handler, or complete a handler's future
 * with it; {@link HttpRequestHandler} answers with exactly this status.
 * Any other exception becomes a 500 with a generic message.
 */
public class ApiException extends RuntimeException {

    private static final long serialVersionUID = 1L;

    private final int status;

    public ApiException(int status, String message) {
        super(message, null, false, false);
        this.status = status;
    }

    public int getStatus() {
        return status;
    }
}
