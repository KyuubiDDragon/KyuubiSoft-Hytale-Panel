package com.kyuubisoft.api.web;

import com.kyuubisoft.api.KyuubiSoftAPI;
import com.kyuubisoft.api.commands.CommandResult;
import com.kyuubisoft.api.commands.CommandRunner;
import com.kyuubisoft.api.commands.CommandService;
import io.netty.handler.codec.http.FullHttpRequest;
import io.netty.handler.codec.http.HttpMethod;

import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;

/**
 * Command endpoints. Each returns a future that {@link HttpRequestHandler}
 * writes once it completes, so a slow command never holds a Netty thread.
 *
 * <ul>
 *   <li>{@code POST /api/commands/execute} {@code {command, actor?, echo?, timeoutMs?}}:
 *       runs the command as {@code Panel:<actor>} and answers with
 *       {@link CommandResult} (HTTP 200 for every outcome, including unknown
 *       or rejected commands). Refused with 403 while {@code insecureDisableAuth}
 *       is on, because it is equivalent to full console access.</li>
 *   <li>{@code GET /api/commands[?ifRevision=…]}: every registered command.</li>
 *   <li>{@code GET /api/commands/complete?line=…}: suggestions for the last token.</li>
 * </ul>
 */
final class CommandRoutes {

    static final String BASE_PATH = "/api/commands";
    static final String EXECUTE_PATH = BASE_PATH + "/execute";
    static final String COMPLETE_PATH = BASE_PATH + "/complete";

    private CommandRoutes() {
    }

    /** True for every path below {@code /api/commands}; CORS preflights stay with the caller. */
    static boolean handles(HttpMethod method, String path) {
        return method != HttpMethod.OPTIONS && (path.equals(BASE_PATH) || path.startsWith(BASE_PATH + "/"));
    }

    /**
     * Route a request under {@link #BASE_PATH}.
     *
     * @return a future of the response body
     * @throws ApiException for a request that cannot be served
     */
    static CompletableFuture<?> route(FullHttpRequest request, String path, Map<String, List<String>> query) {
        HttpMethod method = request.method();
        if (path.equals(EXECUTE_PATH)) {
            requireMethod(method, HttpMethod.POST);
            return execute(service(), request);
        }
        if (path.equals(BASE_PATH)) {
            requireMethod(method, HttpMethod.GET);
            return unavailableAs503(service().registry(HttpRequestHandler.queryParam(query, "ifRevision")));
        }
        if (path.equals(COMPLETE_PATH)) {
            requireMethod(method, HttpMethod.GET);
            String line = HttpRequestHandler.queryParam(query, "line");
            if (line == null || line.length() > CommandService.MAX_COMPLETION_LINE
                    || CommandRunner.containsControlCharacters(line)) {
                throw new ApiException(400, "line must be a single line of at most "
                        + CommandService.MAX_COMPLETION_LINE + " characters");
            }
            return unavailableAs503(service().complete(line));
        }
        throw new ApiException(404, "Endpoint not found: " + AuthGate.loggablePath(path));
    }

    private static CompletableFuture<CommandResult> execute(CommandService service, FullHttpRequest request) {
        KyuubiSoftAPI plugin = KyuubiSoftAPI.getInstance();
        if (plugin.getApiConfig() == null || plugin.getApiConfig().isAuthDisabled()) {
            throw new ApiException(403, "Running commands needs the API token; it is refused while insecureDisableAuth is true");
        }
        ExecuteRequest body = HttpRequestHandler.readJson(request, ExecuteRequest.class);
        String problem = body == null ? "Command is required" : CommandRunner.validate(body.command);
        if (problem != null) throw new ApiException(400, problem);
        CompletableFuture<CommandResult> result = service.execute(body.command, body.actor,
                Boolean.TRUE.equals(body.echo), body.timeoutMs);
        if (result == null) throw new ApiException(503, "Command system not available");
        return result;
    }

    private static CommandService service() {
        KyuubiSoftAPI plugin = KyuubiSoftAPI.getInstance();
        CommandService service = plugin != null ? plugin.getCommandService() : null;
        if (service == null) throw new ApiException(503, "Command service not available");
        return service;
    }

    private static void requireMethod(HttpMethod actual, HttpMethod expected) {
        if (actual != expected) throw new ApiException(405, "Use " + expected.name());
    }

    /** The command system is not up yet (early boot): a 503 the panel can fall back on. */
    private static <T> CompletableFuture<T> unavailableAs503(CompletableFuture<T> future) {
        return future.handle((value, error) -> {
            if (error == null) return value;
            Throwable cause = error instanceof CompletionException && error.getCause() != null ? error.getCause() : error;
            if (cause instanceof IllegalStateException) throw new ApiException(503, cause.getMessage());
            throw error instanceof CompletionException completion ? completion : new CompletionException(error);
        });
    }

    /** Request body of {@code POST /api/commands/execute}. */
    private static final class ExecuteRequest {
        String command;
        String actor;
        Boolean echo;
        Long timeoutMs;
    }
}
