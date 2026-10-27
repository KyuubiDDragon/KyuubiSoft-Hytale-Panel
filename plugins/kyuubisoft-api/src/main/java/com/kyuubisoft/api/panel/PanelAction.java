package com.kyuubisoft.api.panel;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.regex.Pattern;

/**
 * An admin action a {@link PanelInfoProvider} offers as a button in the panel.
 *
 * <pre>{@code
 * PanelAction.builder("reload_config", "Reload configuration", request -> {
 *         plugin.reloadConfig();
 *         return PanelAction.Result.ok("Configuration reloaded");
 *     })
 *     .description("Reads config.json and the pet types from disk again")
 *     .confirm("Apply the configuration files on disk to the running server?")
 *     .build();
 * }</pre>
 *
 * <p>The panel only shows action buttons to accounts with the "run mod actions" permission and
 * records every run in its audit log. An action with {@link Builder#confirm(String) confirm} or
 * {@link Builder#dangerous() dangerous} only runs after the admin confirmed it; KyuubiSoftAPI
 * rejects such a call without that confirmation. Anything destructive must be marked.</p>
 *
 * <p>The handler runs on a KyuubiSoftAPI worker thread with a timeout of 10 seconds. If it needs
 * the world thread, hop over with {@code world.execute(...)} and wait for less than that.</p>
 */
public final class PanelAction {

    private static final Pattern ID = Pattern.compile("[a-z0-9][a-z0-9_.-]{0,63}");

    /** The code behind the button. */
    @FunctionalInterface
    public interface Handler {
        /**
         * @param request who runs it and the checked parameter values
         * @return the outcome shown to the admin
         * @throws Exception any failure; reported as an error, never rethrown into the server
         */
        Result run(PanelRequest request) throws Exception;
    }

    private final String id;
    private final String label;
    private final String description;
    private final String confirmation;
    private final boolean dangerous;
    private final List<Param> params;
    private final Handler handler;

    private PanelAction(Builder builder) {
        this.id = builder.id;
        this.label = builder.label;
        this.description = builder.description;
        this.confirmation = builder.confirmation;
        this.dangerous = builder.dangerous;
        this.params = List.copyOf(builder.params);
        this.handler = builder.handler;
    }

    /**
     * @param id      lowercase letters, digits and {@code . _ -}, at most 64 characters, unique per provider
     * @param label   button text
     * @param handler what the button does
     */
    public static Builder builder(String id, String label, Handler handler) {
        return new Builder(id, label, handler);
    }

    public String id() {
        return id;
    }

    public String label() {
        return label;
    }

    /** Longer explanation, or null. */
    public String description() {
        return description;
    }

    /** Confirmation question the admin has to accept, or null. */
    public String confirmation() {
        return confirmation;
    }

    /** Destructive or hard to undo: shown in red, always confirmed. */
    public boolean isDangerous() {
        return dangerous;
    }

    /** Whether the panel has to ask before running it. */
    public boolean requiresConfirmation() {
        return confirmation != null || dangerous;
    }

    public List<Param> params() {
        return params;
    }

    public Handler handler() {
        return handler;
    }

    public static final class Builder {
        private final String id;
        private final String label;
        private final Handler handler;
        private String description;
        private String confirmation;
        private boolean dangerous;
        private final List<Param> params = new ArrayList<>();

        private Builder(String id, String label, Handler handler) {
            if (id == null || !ID.matcher(id).matches()) {
                throw new IllegalArgumentException("invalid action id: " + id);
            }
            this.id = id;
            this.label = Objects.requireNonNull(label, "label");
            this.handler = Objects.requireNonNull(handler, "handler");
        }

        public Builder description(String description) {
            this.description = description;
            return this;
        }

        /** Ask this question before running the action. */
        public Builder confirm(String question) {
            this.confirmation = Objects.requireNonNull(question, "question");
            return this;
        }

        /** Mark the action as destructive: red button, confirmation required. */
        public Builder dangerous() {
            this.dangerous = true;
            return this;
        }

        /** An input field the admin fills in before running the action. */
        public Builder param(Param param) {
            Objects.requireNonNull(param, "param");
            for (Param existing : params) {
                if (existing.id().equals(param.id())) {
                    throw new IllegalArgumentException("duplicate param id: " + param.id());
                }
            }
            params.add(param);
            return this;
        }

        public PanelAction build() {
            return new PanelAction(this);
        }
    }

    /**
     * An input of an action. Immutable; the setters return copies. KyuubiSoftAPI checks every value
     * against this declaration before the handler runs (see {@link PanelRequest}).
     */
    public static final class Param {

        /** Input kind. */
        public enum Type { TEXT, NUMBER, BOOLEAN, CHOICE }

        /** Longest text a {@link Type#TEXT} param accepts unless {@link #maxLength(int)} says otherwise. */
        public static final int DEFAULT_MAX_LENGTH = 200;

        private final String id;
        private final String label;
        private final Type type;
        private final boolean required;
        private final Object defaultValue;
        private final String hint;
        private final int maxLength;
        private final Double min;
        private final Double max;
        private final boolean integer;
        private final List<String> choices;

        private Param(String id, String label, Type type, boolean required, Object defaultValue, String hint,
                      int maxLength, Double min, Double max, boolean integer, List<String> choices) {
            if (id == null || !ID.matcher(id).matches()) {
                throw new IllegalArgumentException("invalid param id: " + id);
            }
            this.id = id;
            this.label = Objects.requireNonNull(label, "label");
            this.type = type;
            this.required = required;
            this.defaultValue = defaultValue;
            this.hint = hint;
            this.maxLength = maxLength;
            this.min = min;
            this.max = max;
            this.integer = integer;
            this.choices = choices;
        }

        public static Param text(String id, String label) {
            return new Param(id, label, Type.TEXT, false, null, null, DEFAULT_MAX_LENGTH, null, null, false, List.of());
        }

        public static Param number(String id, String label) {
            return new Param(id, label, Type.NUMBER, false, null, null, 0, null, null, false, List.of());
        }

        public static Param bool(String id, String label) {
            return new Param(id, label, Type.BOOLEAN, false, null, null, 0, null, null, false, List.of());
        }

        /** One of a fixed list of values; the admin picks from a dropdown. */
        public static Param choice(String id, String label, String... choices) {
            Objects.requireNonNull(choices, "choices");
            if (choices.length == 0) throw new IllegalArgumentException("a choice param needs options");
            for (String choice : choices) Objects.requireNonNull(choice, "choice");
            return new Param(id, label, Type.CHOICE, false, null, null, 0, null, null, false, List.of(choices));
        }

        /** The admin has to provide a value. */
        public Param required() {
            return new Param(id, label, type, true, defaultValue, hint, maxLength, min, max, integer, choices);
        }

        /**
         * Value used (and pre-filled) when the admin leaves the field empty. It has to pass the
         * param's own checks; {@link PanelRegistry#register} refuses the provider otherwise.
         */
        public Param defaultValue(Object value) {
            return new Param(id, label, type, required, value, hint, maxLength, min, max, integer, choices);
        }

        /** Help text under the field. */
        public Param hint(String hint) {
            return new Param(id, label, type, required, defaultValue, hint, maxLength, min, max, integer, choices);
        }

        /** Longest accepted text (TEXT only), 1 to 2000. */
        public Param maxLength(int maxLength) {
            if (maxLength < 1 || maxLength > 2000) throw new IllegalArgumentException("maxLength must be 1..2000");
            return new Param(id, label, type, required, defaultValue, hint, maxLength, min, max, integer, choices);
        }

        /** Accepted range, both ends included (NUMBER only). */
        public Param range(double min, double max) {
            requireFinite(min, "min");
            requireFinite(max, "max");
            if (min > max) throw new IllegalArgumentException("min must not be greater than max");
            return new Param(id, label, type, required, defaultValue, hint, maxLength, min, max, integer, choices);
        }

        /** Smallest accepted value (NUMBER only). */
        public Param min(double min) {
            requireFinite(min, "min");
            return new Param(id, label, type, required, defaultValue, hint, maxLength, min, max, integer, choices);
        }

        /** Largest accepted value (NUMBER only). */
        public Param max(double max) {
            requireFinite(max, "max");
            return new Param(id, label, type, required, defaultValue, hint, maxLength, min, max, integer, choices);
        }

        private static void requireFinite(double value, String what) {
            if (Double.isNaN(value) || Double.isInfinite(value)) {
                throw new IllegalArgumentException(what + " must be a finite number");
            }
        }

        /** Whole numbers only (NUMBER only); the handler then gets a {@code Long}. */
        public Param integer() {
            return new Param(id, label, type, required, defaultValue, hint, maxLength, min, max, true, choices);
        }

        public String id() {
            return id;
        }

        public String label() {
            return label;
        }

        public Type type() {
            return type;
        }

        public boolean isRequired() {
            return required;
        }

        public Object defaultValue() {
            return defaultValue;
        }

        public String hint() {
            return hint;
        }

        public int maxLength() {
            return maxLength;
        }

        /** Smallest accepted value, or null for none. */
        public Double minValue() {
            return min;
        }

        /** Largest accepted value, or null for none. */
        public Double maxValue() {
            return max;
        }

        public boolean isInteger() {
            return integer;
        }

        public List<String> choices() {
            return choices;
        }
    }

    /** What an action reports back to the admin. */
    public static final class Result {
        private final boolean success;
        private final String message;
        private final Map<String, Object> data;

        private Result(boolean success, String message, Map<String, ?> data) {
            this.success = success;
            this.message = message;
            this.data = data == null || data.isEmpty()
                    ? Map.of()
                    : Collections.unmodifiableMap(new LinkedHashMap<>(data));
        }

        public static Result ok(String message) {
            return new Result(true, message, null);
        }

        /** Success with extra key/value details (shown as a small list; same value rules as metrics). */
        public static Result ok(String message, Map<String, ?> data) {
            return new Result(true, message, data);
        }

        /** The action ran but could not do its job; the message says why. */
        public static Result failed(String message) {
            return new Result(false, message, null);
        }

        public boolean isSuccess() {
            return success;
        }

        public String message() {
            return message;
        }

        public Map<String, Object> data() {
            return data;
        }
    }
}
