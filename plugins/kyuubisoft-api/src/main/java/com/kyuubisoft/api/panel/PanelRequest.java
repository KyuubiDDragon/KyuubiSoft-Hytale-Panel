package com.kyuubisoft.api.panel;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * What the panel sends along with a snapshot or action call.
 *
 * <p>For actions, {@link #params()} holds the values the admin entered, already checked against
 * the action's {@link PanelAction.Param} declarations: only declared ids, the declared type
 * ({@code String}, {@code Double}/{@code Long} for numbers, {@code Boolean}), required values
 * present, text without control characters and within its length, numbers within their range,
 * choices from their list. Defaults are filled in. Snapshot calls have no params.</p>
 */
public final class PanelRequest {

    private final String actor;
    private final String locale;
    private final Map<String, Object> params;

    /**
     * @param actor  panel account that triggered the call, or null when unknown
     * @param locale UI language of that account (for example {@code "de"}), or null
     * @param params checked parameter values; copied
     */
    public PanelRequest(String actor, String locale, Map<String, ?> params) {
        this.actor = actor;
        this.locale = locale;
        this.params = params == null || params.isEmpty()
                ? Map.of()
                : Collections.unmodifiableMap(new LinkedHashMap<>(params));
    }

    /** Panel account that triggered the call, or null. Informational (for your own logs). */
    public String actor() {
        return actor;
    }

    /** UI language of the panel account (for example {@code "en"}, {@code "de"}), or null. */
    public String locale() {
        return locale;
    }

    /** Checked parameter values by id; unmodifiable. */
    public Map<String, Object> params() {
        return params;
    }

    /** Text or choice parameter, or null when absent. */
    public String getString(String id) {
        Object value = params.get(id);
        return value == null ? null : value.toString();
    }

    /** Number parameter ({@code Long} for integer params, otherwise {@code Double}), or null. */
    public Number getNumber(String id) {
        return params.get(id) instanceof Number number ? number : null;
    }

    /** Boolean parameter; false when absent. */
    public boolean getBoolean(String id) {
        return params.get(id) instanceof Boolean flag && flag;
    }
}
