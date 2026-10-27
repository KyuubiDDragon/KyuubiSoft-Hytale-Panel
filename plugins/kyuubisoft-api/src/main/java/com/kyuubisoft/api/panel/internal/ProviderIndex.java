package com.kyuubisoft.api.panel.internal;

import com.kyuubisoft.api.panel.PanelAction;
import com.kyuubisoft.api.panel.PanelInfoProvider;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Registered providers with their metadata read once at registration, so listing them never
 * calls into mod code. Internal; mods use {@link com.kyuubisoft.api.panel.PanelRegistry}.
 */
public final class ProviderIndex {

    static final int MAX_ACTIONS = 20;
    static final int MAX_PARAMS = 10;

    private static final Map<String, Registered> PROVIDERS = new ConcurrentHashMap<>();

    private ProviderIndex() {}

    /** A provider and the metadata it reported when it was registered. */
    public record Registered(PanelInfoProvider provider, String id, String displayName, String description,
                             String version, List<PanelAction> actions) {

        public Optional<PanelAction> action(String actionId) {
            for (PanelAction action : actions) {
                if (action.id().equals(actionId)) return Optional.of(action);
            }
            return Optional.empty();
        }
    }

    /**
     * Reads the provider's metadata (on the caller's thread: the mod registering itself) and
     * stores it under its id.
     *
     * @return the replaced entry, or null
     */
    public static Registered register(PanelInfoProvider provider) {
        String id = provider.id();
        if (!PanelWire.isValidProviderId(id)) {
            throw new IllegalArgumentException("invalid panel provider id: " + id);
        }
        List<PanelAction> actions = provider.actions() == null ? List.of() : List.copyOf(provider.actions());
        if (actions.size() > MAX_ACTIONS) {
            throw new IllegalArgumentException("at most " + MAX_ACTIONS + " actions per provider");
        }
        Map<String, PanelAction> byId = new LinkedHashMap<>();
        for (PanelAction action : actions) {
            if (byId.put(action.id(), action) != null) {
                throw new IllegalArgumentException("duplicate action id: " + action.id());
            }
            if (action.params().size() > MAX_PARAMS) {
                throw new IllegalArgumentException("at most " + MAX_PARAMS + " params per action");
            }
            for (PanelAction.Param param : action.params()) PanelWire.checkDefault(action, param);
        }
        String displayName = provider.displayName();
        Registered entry = new Registered(provider, id,
                PanelWire.clip(displayName == null || displayName.isBlank() ? id : displayName, 100),
                PanelWire.clip(provider.description(), 300),
                PanelWire.clip(provider.version(), 40),
                actions);
        return PROVIDERS.put(id, entry);
    }

    /** Removes this provider instance only. */
    public static boolean unregister(PanelInfoProvider provider) {
        return PROVIDERS.values().removeIf(entry -> entry.provider() == provider);
    }

    /** Removes every provider whose class was loaded by {@code owner}. */
    public static int unregisterAll(ClassLoader owner) {
        int[] removed = {0};
        PROVIDERS.values().removeIf(entry -> {
            boolean owned = entry.provider().getClass().getClassLoader() == owner;
            if (owned) removed[0]++;
            return owned;
        });
        return removed[0];
    }

    /** All entries, ordered by id. */
    public static List<Registered> list() {
        return new ArrayList<>(new TreeMap<>(PROVIDERS).values());
    }

    public static Optional<Registered> get(String id) {
        return id == null ? Optional.empty() : Optional.ofNullable(PROVIDERS.get(id));
    }
}
