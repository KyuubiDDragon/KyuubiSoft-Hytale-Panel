package com.kyuubisoft.api.panel;

import com.kyuubisoft.api.panel.internal.ModEvents;
import com.kyuubisoft.api.panel.internal.ProviderIndex;

import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.logging.Logger;

/**
 * Entry point for mods that want to show up in the KyuubiSoft Panel.
 *
 * <p>Depend on KyuubiSoftAPI optionally ({@code "OptionalDependencies": {"KyuubiDDragon:KyuubiSoftAPI": "*"}}
 * in the manifest) and keep every reference to this package in a nested holder class that is only
 * loaded when the plugin is present; a {@code Class.forName} check alone is not enough. Without
 * KyuubiSoftAPI the mod then runs unchanged. See the plugin README, section "Integrating your mod".</p>
 *
 * <p>All methods are thread-safe and never wait for anything. Registrations live as long as
 * KyuubiSoftAPI's classes: registering again with the same id (for example after the mod was
 * reloaded) replaces the old entry. When KyuubiSoftAPI itself is reloaded, mods that depend on it
 * optionally have to be reloaded too (or the server restarted) to show up again.</p>
 */
public final class PanelRegistry {

    private static final Logger LOGGER = Logger.getLogger("KyuubiSoftAPI");
    private static final int API_VERSION = 1;

    private PanelRegistry() {}

    /**
     * Version of this API in the installed KyuubiSoftAPI. Raised only for incompatible changes;
     * additions keep it. A method, not a constant, so a mod reads the installed value at runtime.
     */
    public static int apiVersion() {
        return API_VERSION;
    }

    /**
     * Adds a provider, replacing one registered earlier under the same id. Reads its
     * {@link PanelInfoProvider#displayName() name}, description, version and
     * {@link PanelInfoProvider#actions() actions} once, right here; register again to change them.
     *
     * @throws IllegalArgumentException when the id or the actions break the documented rules
     *                                  (id format, at most 20 actions with unique ids, at most 10
     *                                  params each, defaults that pass their own param's checks)
     */
    public static void register(PanelInfoProvider provider) {
        Objects.requireNonNull(provider, "provider");
        ProviderIndex.Registered previous = ProviderIndex.register(provider);
        String id = provider.id();
        if (previous == null) {
            LOGGER.info("Panel provider registered: " + id);
        } else if (previous.provider() != provider) {
            LOGGER.info("Panel provider replaced: " + id);
        }
    }

    /**
     * Removes this provider instance. A newer provider registered under the same id stays.
     *
     * @return whether it was registered
     */
    public static boolean unregister(PanelInfoProvider provider) {
        return provider != null && ProviderIndex.unregister(provider);
    }

    /**
     * Removes every provider whose class was loaded by {@code owner}, usually the mod's own class
     * loader ({@code getClass().getClassLoader()}).
     *
     * @return number of removed providers
     */
    public static int unregisterAll(ClassLoader owner) {
        return owner == null ? 0 : ProviderIndex.unregisterAll(owner);
    }

    /** All registered providers, ordered by id. */
    public static List<PanelInfoProvider> providers() {
        return ProviderIndex.list().stream().map(ProviderIndex.Registered::provider).toList();
    }

    /** The provider registered under this id. */
    public static Optional<PanelInfoProvider> find(String id) {
        return ProviderIndex.get(id).map(ProviderIndex.Registered::provider);
    }

    /**
     * Sends an event to the panel. It arrives on the panel's event bus as {@code mod_event}, so
     * webhooks, event actions and the replay recorder see it.
     *
     * <p>{@code modId} uses the provider id format, {@code type} lowercase letters, digits and
     * {@code . _ -} (at most 64 characters). The payload may contain null, Boolean, Number,
     * String, Map (String keys), List and array values; it is cut to 4 levels, 50 entries per map
     * or list and 1000 characters per text, control characters are removed. Each mod may send 20
     * events per second on average (bursts up to 40); more are dropped. Events only reach panels
     * connected right now, nothing is buffered.</p>
     *
     * <p>Payload values may end up in Discord/Slack webhooks and as placeholders in panel event
     * actions: never put secrets in them.</p>
     *
     * @return false when the event was rejected (invalid ids, rate limit, KyuubiSoftAPI not running)
     */
    public static boolean publishEvent(String modId, String type, Map<String, ?> payload) {
        return ModEvents.publish(modId, type, payload);
    }
}
