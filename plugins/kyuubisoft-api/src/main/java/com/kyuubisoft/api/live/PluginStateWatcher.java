package com.kyuubisoft.api.live;

import java.util.HashMap;
import java.util.Map;
import java.util.Objects;
import java.util.function.Consumer;
import java.util.logging.Logger;

/**
 * Emits {@code plugin_state} when a plugin/mod changes its load state
 * (enabled, failed, disabled, reloaded, unloaded). The server only raises an
 * event for setup, so the watcher compares periodic snapshots instead; the
 * first snapshot is the baseline and produces no events.
 */
final class PluginStateWatcher implements Runnable {

    /** Reported as "to" when a plugin disappears from the manager (unload). */
    static final String UNLOADED = "UNLOADED";

    private static final Logger LOGGER = Logger.getLogger("KyuubiSoftAPI");

    private final PluginStatusCollector collector;
    private final Consumer<Object> sink;
    private Map<String, PluginStatusCollector.PluginInfo> previous;

    PluginStateWatcher(PluginStatusCollector collector, Consumer<Object> sink) {
        this.collector = collector;
        this.sink = sink;
    }

    @Override
    public void run() {
        try {
            Map<String, PluginStatusCollector.PluginInfo> current = collector.snapshot();
            if (previous != null) diff(previous, current);
            previous = current;
        } catch (Throwable t) {
            // Never let one failed poll kill the scheduler.
            LOGGER.warning("[Data] Plugin state poll failed: " + t.getMessage());
        }
    }

    private void diff(Map<String, PluginStatusCollector.PluginInfo> before,
                      Map<String, PluginStatusCollector.PluginInfo> after) {
        Map<String, PluginStatusCollector.PluginInfo> gone = new HashMap<>(before);
        for (PluginStatusCollector.PluginInfo now : after.values()) {
            PluginStatusCollector.PluginInfo old = gone.remove(now.id);
            String from = old == null ? PluginStatusCollector.NOT_LOADED : old.state;
            if (!Objects.equals(from, now.state)) emit(now, from, now.state);
        }
        for (PluginStatusCollector.PluginInfo old : gone.values()) {
            emit(old, old.state, UNLOADED);
        }
    }

    private void emit(PluginStatusCollector.PluginInfo info, String from, String to) {
        LiveEvents.PluginStateChanged event = new LiveEvents.PluginStateChanged();
        event.plugin = info.id;
        event.name = info.name;
        event.version = info.version;
        event.from = from;
        event.to = to;
        event.error = info.error;
        try {
            sink.accept(event);
        } catch (Throwable t) {
            LOGGER.warning("[Data] Event broadcast failed: " + t.getMessage());
        }
    }
}
