package com.kyuubisoft.api.panel;

import java.util.List;

/**
 * A status page a mod contributes to the panel's "Mod status" view.
 *
 * <p>Register an instance with {@link PanelRegistry#register(PanelInfoProvider)} when the mod
 * starts and remove it with {@link PanelRegistry#unregister(PanelInfoProvider)} when it shuts
 * down. The panel then lists it, renders its {@link #snapshot(PanelRequest) snapshot} (metric
 * tiles, tables, notices) and offers its {@link #actions() actions} as buttons.</p>
 *
 * <p><b>Threading.</b> {@link #snapshot(PanelRequest)} and the action handlers run on a
 * KyuubiSoftAPI worker thread, never on a world thread, and each call is bounded by a timeout
 * (the other methods are read once, on the thread that registers the provider). Read your own
 * thread-safe in-memory state only:
 * whatever needs an ECS store, compute it on the world thread yourself (for example in a periodic
 * {@code world.execute}) and let {@link #snapshot(PanelRequest)} read that cache.</p>
 */
public interface PanelInfoProvider {

    /**
     * Stable id: lowercase letters, digits and {@code . _ : -}, starting with a letter or digit,
     * at most 64 characters. Use the plugin identifier, for example {@code "kyuubisoft:pets"}.
     */
    String id();

    /** Name shown in the panel. Defaults to the id. */
    default String displayName() {
        return id();
    }

    /** One line shown under the name, or null. */
    default String description() {
        return null;
    }

    /** Version shown next to the name, usually the mod version, or null. */
    default String version() {
        return null;
    }

    /**
     * The current status. Called when an admin opens or refreshes the provider in the panel,
     * with a timeout of a few seconds. Must be fast and must not block on a world thread.
     *
     * @param request who asks, and in which UI language
     * @throws Exception any failure; the panel shows it as an error of this provider
     */
    PanelSnapshot snapshot(PanelRequest request) throws Exception;

    /**
     * Admin actions offered as buttons; an empty list (the default) means no buttons. Read once
     * when the provider is registered, together with the name, description and version.
     */
    default List<PanelAction> actions() {
        return List.of();
    }
}
