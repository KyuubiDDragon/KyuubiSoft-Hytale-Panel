package com.kyuubisoft.api.panel.internal;

import com.kyuubisoft.api.panel.PanelAction;
import com.kyuubisoft.api.panel.PanelRequest;
import com.kyuubisoft.api.panel.PanelSnapshot;
import com.kyuubisoft.api.websocket.EventBroadcaster;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Callable;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Future;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.SynchronousQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.logging.Logger;

/**
 * Runs mod code (snapshots, action handlers) isolated from the web server: on its own small
 * thread pool, with a timeout, at most one snapshot and one action per provider at a time, and
 * every exception turned into a status. A provider that hangs keeps at most two worker threads
 * busy and answers "busy" until its call returns; it takes eight such providers to use up the
 * pool. Internal.
 */
public final class PanelRuntime {

    private static final Logger LOGGER = Logger.getLogger("KyuubiSoftAPI");

    public static final long SNAPSHOT_TIMEOUT_MS = 3_000;
    public static final long ACTION_TIMEOUT_MS = 10_000;
    private static final int MAX_WORKERS = 16;
    private static final int MAX_ERROR_LENGTH = 300;
    private static final long FAILURE_LOG_INTERVAL_MS = 60_000;

    private static volatile PanelRuntime current;

    private final EventBroadcaster broadcaster;
    private final ThreadPoolExecutor workers;
    private final ScheduledThreadPoolExecutor timer;
    private final Set<String> busy = ConcurrentHashMap.newKeySet();
    /** Last warning per provider call and status, so a failing provider polled every few seconds does not flood the log. */
    private final Map<String, Long> lastFailureLog = new ConcurrentHashMap<>();

    private PanelRuntime(EventBroadcaster broadcaster) {
        this.broadcaster = broadcaster;
        AtomicInteger counter = new AtomicInteger();
        this.workers = new ThreadPoolExecutor(0, MAX_WORKERS, 30, TimeUnit.SECONDS, new SynchronousQueue<>(), r -> {
            Thread t = new Thread(r, "KyuubiSoftAPI-ModPanel-" + counter.incrementAndGet());
            t.setDaemon(true);
            return t;
        });
        this.timer = new ScheduledThreadPoolExecutor(1, r -> {
            Thread t = new Thread(r, "KyuubiSoftAPI-ModPanel-Timer");
            t.setDaemon(true);
            return t;
        });
        this.timer.setRemoveOnCancelPolicy(true);
    }

    /** Starts the runtime; called from the plugin's setup. */
    public static synchronized void start(EventBroadcaster broadcaster) {
        if (current != null) current.close();
        current = new PanelRuntime(broadcaster);
    }

    /** Stops the worker threads; registrations stay (they belong to the registry). */
    public static synchronized void stop() {
        if (current == null) return;
        current.close();
        current = null;
    }

    /** The running runtime, or null before setup / after shutdown. */
    public static PanelRuntime current() {
        return current;
    }

    EventBroadcaster broadcaster() {
        return broadcaster;
    }

    private void close() {
        workers.shutdownNow();
        timer.shutdownNow();
    }

    // ---------------------------------------------------------------- calls

    /** Outcome of a snapshot call, ready to serialize. */
    public CompletableFuture<Map<String, Object>> snapshot(ProviderIndex.Registered entry, PanelRequest request) {
        long started = System.nanoTime();
        return call(entry.id() + "#snapshot", SNAPSHOT_TIMEOUT_MS, () -> {
            PanelSnapshot snapshot = entry.provider().snapshot(request);
            if (snapshot == null) throw new IllegalStateException("snapshot() returned null");
            return PanelWire.snapshot(snapshot);
        }).handle((wire, error) -> {
            Map<String, Object> out = PanelWire.provider(entry);
            out.put("generatedAt", Instant.now().toString());
            out.put("durationMs", elapsedMs(started));
            if (error == null) {
                out.put("status", "ok");
                out.put("snapshot", wire);
            } else {
                Failure failure = Failure.of(error);
                logFailure(failure, "snapshot", entry.id());
                out.put("status", failure.status);
                out.put("error", failure.message);
            }
            return out;
        });
    }

    /** Outcome of an action call with already checked parameters, ready to serialize. */
    public CompletableFuture<Map<String, Object>> action(ProviderIndex.Registered entry, PanelAction action,
                                                         PanelRequest request) {
        long started = System.nanoTime();
        return call(entry.id() + "#action", ACTION_TIMEOUT_MS, () -> {
            PanelAction.Result result = action.handler().run(request);
            if (result == null) throw new IllegalStateException("the action returned no result");
            // Converted here, inside the guarded call: the mod's values may throw in toString().
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("success", result.isSuccess());
            out.put("status", result.isSuccess() ? "ok" : "failed");
            out.put("message", PanelWire.clip(result.message(), PanelWire.MAX_TEXT));
            out.put("data", PanelWire.data(result.data()));
            return out;
        }).handle((result, error) -> {
            Map<String, Object> out = new LinkedHashMap<>();
            if (error == null) {
                out.putAll(result);
            } else {
                Failure failure = Failure.of(error);
                logFailure(failure, "action " + action.id(), entry.id());
                out.put("success", false);
                out.put("status", failure.status);
                out.put("message", failure.message);
            }
            out.put("durationMs", elapsedMs(started));
            LOGGER.info("Panel action " + entry.id() + "/" + action.id() + " by "
                    + (request.actor() == null ? "unknown panel user" : request.actor()) + ": " + out.get("status"));
            return out;
        });
    }

    /**
     * Runs {@code task} on a worker. The returned future completes with the result, with
     * {@link TimeoutException} after {@code timeoutMs}, or with {@link BusyException} when the
     * same key is still running or no worker is free. The key is released only when the task
     * really ends, so a hanging provider cannot pile up threads.
     */
    <T> CompletableFuture<T> call(String key, long timeoutMs, Callable<T> task) {
        CompletableFuture<T> future = new CompletableFuture<>();
        if (!busy.add(key)) {
            future.completeExceptionally(new BusyException());
            return future;
        }
        Future<?> running;
        try {
            running = workers.submit(() -> {
                try {
                    future.complete(task.call());
                } catch (Throwable t) {
                    future.completeExceptionally(t);
                } finally {
                    busy.remove(key);
                }
            });
        } catch (RejectedExecutionException e) {
            busy.remove(key);
            future.completeExceptionally(new BusyException());
            return future;
        }
        try {
            ScheduledFuture<?> deadline = timer.schedule(() -> {
                // Interrupt the provider; if it ignores that, its key stays taken until it returns.
                if (future.completeExceptionally(new TimeoutException())) running.cancel(true);
            }, timeoutMs, TimeUnit.MILLISECONDS);
            future.whenComplete((value, error) -> deadline.cancel(false));
        } catch (RejectedExecutionException e) {
            // stop() raced this call: give up on it like on a timeout
            running.cancel(true);
            future.completeExceptionally(new BusyException());
        }
        return future;
    }

    /** Busy at FINE; timeouts and errors as WARNING, at most once a minute per provider call and status. */
    private void logFailure(Failure failure, String what, String providerId) {
        if ("busy".equals(failure.status)) {
            LOGGER.fine("Panel provider " + providerId + ": " + what + " refused, still busy");
            return;
        }
        String key = providerId + "#" + what + "#" + failure.status;
        long now = System.currentTimeMillis();
        Long last = lastFailureLog.get(key);
        if (last != null && now - last < FAILURE_LOG_INTERVAL_MS) return;
        lastFailureLog.put(key, now);
        LOGGER.warning("Panel provider " + providerId + ": " + what + " "
                + (failure.cause == null ? failure.status : "failed: " + failure.detail)
                + " (repeats are logged at most once per minute)");
    }

    private static long elapsedMs(long startedNanos) {
        return TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedNanos);
    }

    /** Refused because the provider is still busy with the previous call or the pool is full. */
    static final class BusyException extends RuntimeException {
        private static final long serialVersionUID = 1L;

        BusyException() {
            super("busy", null, false, false);
        }
    }

    /**
     * A failed call as status + message for the panel. An exception's own text
     * can hold paths or internal state of the mod, so the panel only gets its
     * class name; {@code detail} with the text goes to the server log.
     */
    private record Failure(String status, String message, String detail, Throwable cause) {
        static Failure of(Throwable error) {
            Throwable cause = error instanceof CompletionException && error.getCause() != null
                    ? error.getCause() : error;
            if (cause instanceof TimeoutException) {
                return new Failure("timeout", "No answer within the time limit", null, null);
            }
            if (cause instanceof BusyException) {
                return new Failure("busy", "Still busy with the previous request", null, null);
            }
            String type = cause.getClass().getSimpleName();
            String detail = type + (cause.getMessage() == null ? "" : ": " + cause.getMessage());
            return new Failure("error", type + " (details in the server log)",
                    PanelWire.clip(detail, MAX_ERROR_LENGTH), cause);
        }
    }
}
