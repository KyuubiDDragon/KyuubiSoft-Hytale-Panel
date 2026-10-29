package com.kyuubisoft.api.panel.internal;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import com.kyuubisoft.api.panel.PanelAction;
import com.kyuubisoft.api.panel.PanelSnapshot;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Turns the API objects into the JSON the panel receives, enforcing the documented size limits,
 * and checks submitted action parameters. Internal.
 */
public final class PanelWire {

    private static final Pattern PROVIDER_ID = Pattern.compile("[a-z0-9][a-z0-9._:-]{0,63}");
    private static final Pattern NAME = Pattern.compile("[a-z0-9][a-z0-9_.-]{0,63}");

    static final int MAX_TEXT = 500;
    static final int MAX_NOTICES = 20;
    static final int MAX_SECTIONS = 20;
    static final int MAX_METRICS = 30;
    static final int MAX_TABLES = 10;
    static final int MAX_COLUMNS = 16;
    static final int MAX_ROWS = 200;
    static final int MAX_DATA_ENTRIES = 30;

    private PanelWire() {}

    public static boolean isValidProviderId(String id) {
        return id != null && PROVIDER_ID.matcher(id).matches();
    }

    /** Action ids and event types. */
    public static boolean isValidName(String name) {
        return name != null && NAME.matcher(name).matches();
    }

    /**
     * Text without control characters and bidi overrides, at most {@code max} characters (never
     * ending in half a surrogate pair); null stays null.
     */
    public static String clip(String text, int max) {
        if (text == null) return null;
        StringBuilder out = new StringBuilder(Math.min(text.length(), max));
        for (int i = 0; i < text.length() && out.length() < max; i++) {
            char c = text.charAt(i);
            if (isBidiControl(c)) continue;
            out.append(Character.isISOControl(c) ? ' ' : c);
        }
        if (out.length() > 0 && Character.isHighSurrogate(out.charAt(out.length() - 1))) {
            out.setLength(out.length() - 1);
        }
        return out.toString();
    }

    /** Characters that reorder text on screen (could make a mod value look like something else). */
    private static boolean isBidiControl(char c) {
        return c == '\u200E' || c == '\u200F' || (c >= '\u202A' && c <= '\u202E') || (c >= '\u2066' && c <= '\u2069');
    }

    // ---------------------------------------------------------------- metadata

    public static Map<String, Object> provider(ProviderIndex.Registered entry) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", entry.id());
        out.put("displayName", entry.displayName());
        out.put("description", entry.description());
        out.put("version", entry.version());
        out.put("actions", actions(entry.actions()));
        return out;
    }

    public static List<Map<String, Object>> actions(List<PanelAction> actions) {
        List<Map<String, Object>> out = new ArrayList<>(actions.size());
        for (PanelAction action : actions) out.add(action(action));
        return out;
    }

    static Map<String, Object> action(PanelAction action) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", action.id());
        out.put("label", clip(action.label(), 100));
        out.put("description", clip(action.description(), MAX_TEXT));
        out.put("confirmation", clip(action.confirmation(), MAX_TEXT));
        out.put("requiresConfirmation", action.requiresConfirmation());
        out.put("dangerous", action.isDangerous());
        List<Map<String, Object>> params = new ArrayList<>();
        for (PanelAction.Param param : action.params()) params.add(param(param));
        out.put("params", params);
        return out;
    }

    private static Map<String, Object> param(PanelAction.Param param) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", param.id());
        out.put("label", clip(param.label(), 100));
        out.put("type", param.type().name().toLowerCase(Locale.ROOT));
        out.put("required", param.isRequired());
        out.put("defaultValue", value(param.defaultValue()));
        out.put("hint", clip(param.hint(), MAX_TEXT));
        switch (param.type()) {
            case TEXT -> out.put("maxLength", param.maxLength());
            case NUMBER -> {
                out.put("min", param.minValue());
                out.put("max", param.maxValue());
                out.put("integer", param.isInteger());
            }
            case CHOICE -> {
                List<String> choices = new ArrayList<>();
                for (String choice : param.choices()) choices.add(clip(choice, 100));
                out.put("choices", choices);
            }
            default -> { }
        }
        return out;
    }

    // ---------------------------------------------------------------- snapshot

    public static Map<String, Object> snapshot(PanelSnapshot snapshot) {
        Map<String, Object> out = new LinkedHashMap<>();
        boolean truncated = snapshot.notices().size() > MAX_NOTICES || snapshot.sections().size() > MAX_SECTIONS;

        List<Map<String, Object>> notices = new ArrayList<>();
        for (PanelSnapshot.Notice notice : head(snapshot.notices(), MAX_NOTICES)) {
            Map<String, Object> n = new LinkedHashMap<>();
            n.put("tone", tone(notice.tone()));
            n.put("text", clip(notice.text(), MAX_TEXT));
            notices.add(n);
        }

        List<Map<String, Object>> sections = new ArrayList<>();
        for (PanelSnapshot.Section section : head(snapshot.sections(), MAX_SECTIONS)) {
            truncated |= section.metrics().size() > MAX_METRICS || section.tables().size() > MAX_TABLES;
            Map<String, Object> s = new LinkedHashMap<>();
            s.put("title", clip(section.title(), 100));
            s.put("description", clip(section.description(), MAX_TEXT));
            List<Map<String, Object>> metrics = new ArrayList<>();
            for (PanelSnapshot.Metric metric : head(section.metrics(), MAX_METRICS)) metrics.add(metric(metric));
            s.put("metrics", metrics);
            List<Map<String, Object>> tables = new ArrayList<>();
            for (PanelSnapshot.Table table : head(section.tables(), MAX_TABLES)) tables.add(table(table));
            s.put("tables", tables);
            sections.add(s);
        }

        out.put("notices", notices);
        out.put("sections", sections);
        out.put("truncated", truncated);
        return out;
    }

    private static Map<String, Object> metric(PanelSnapshot.Metric metric) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("label", clip(metric.label(), 100));
        out.put("value", value(metric.value()));
        out.put("unit", clip(metric.unit(), 20));
        out.put("hint", clip(metric.hint(), MAX_TEXT));
        out.put("tone", tone(metric.tone()));
        return out;
    }

    private static Map<String, Object> table(PanelSnapshot.Table table) {
        Map<String, Object> out = new LinkedHashMap<>();
        List<String> columns = new ArrayList<>();
        for (String column : head(table.columns(), MAX_COLUMNS)) columns.add(clip(column, 100));
        List<List<Object>> rows = new ArrayList<>();
        for (List<Object> row : head(table.rows(), MAX_ROWS)) {
            List<Object> cells = new ArrayList<>(columns.size());
            for (int i = 0; i < columns.size(); i++) cells.add(i < row.size() ? value(row.get(i)) : null);
            rows.add(cells);
        }
        out.put("title", clip(table.title(), 100));
        out.put("columns", columns);
        out.put("rows", rows);
        out.put("totalRows", table.rows().size());
        out.put("truncated", table.rows().size() > MAX_ROWS || table.columns().size() > MAX_COLUMNS);
        out.put("emptyText", clip(table.emptyText(), MAX_TEXT));
        return out;
    }

    /** Action result details: at most 30 entries of plain values. */
    public static Map<String, Object> data(Map<String, Object> data) {
        Map<String, Object> out = new LinkedHashMap<>();
        for (Map.Entry<String, Object> entry : data.entrySet()) {
            if (out.size() >= MAX_DATA_ENTRIES) break;
            if (entry.getKey() == null) continue;
            out.put(clip(entry.getKey(), 64), value(entry.getValue()));
        }
        return out;
    }

    /** null, Boolean, Number or a clipped String. */
    static Object value(Object value) {
        if (value == null || value instanceof Boolean) return value;
        if (value instanceof Number number) {
            double d = number.doubleValue();
            return Double.isNaN(d) || Double.isInfinite(d) ? number.toString() : number;
        }
        return clip(value instanceof Enum<?> e ? e.name() : String.valueOf(value), MAX_TEXT);
    }

    private static String tone(PanelSnapshot.Tone tone) {
        return (tone == null ? PanelSnapshot.Tone.NEUTRAL : tone).name().toLowerCase(Locale.ROOT);
    }

    private static <T> List<T> head(List<T> list, int max) {
        return list.size() <= max ? list : list.subList(0, max);
    }

    // ---------------------------------------------------------------- parameters

    /** Checked values, or why the submitted parameters were refused. */
    public record ParamCheck(Map<String, Object> values, String error) {
        static ParamCheck ok(Map<String, Object> values) {
            return new ParamCheck(values, null);
        }

        static ParamCheck refused(String error) {
            return new ParamCheck(null, error);
        }

        public boolean isOk() {
            return error == null;
        }
    }

    /** Checks {@code submitted} (may be null) against the action's declared parameters. */
    public static ParamCheck checkParams(PanelAction action, JsonObject submitted) {
        Map<String, PanelAction.Param> declared = new LinkedHashMap<>();
        for (PanelAction.Param param : action.params()) declared.put(param.id(), param);
        if (submitted != null) {
            for (String key : submitted.keySet()) {
                if (!declared.containsKey(key)) return ParamCheck.refused("unknown parameter: " + clip(key, 64));
            }
        }

        Map<String, Object> values = new LinkedHashMap<>();
        for (PanelAction.Param param : declared.values()) {
            JsonElement raw = submitted == null ? null : submitted.get(param.id());
            boolean missing = raw == null || raw.isJsonNull()
                    || (raw.isJsonPrimitive() && raw.getAsJsonPrimitive().isString() && raw.getAsString().isEmpty());
            if (missing) {
                if (param.defaultValue() != null) {
                    // checked at registration (checkDefault), so this cannot fail
                    values.put(param.id(), check(param, primitive(param.defaultValue())));
                } else if (param.isRequired()) {
                    return ParamCheck.refused(param.id() + " is required");
                }
                continue;
            }
            if (!raw.isJsonPrimitive()) return ParamCheck.refused(param.id() + " must be a single value");
            Object checked;
            try {
                checked = check(param, raw.getAsJsonPrimitive());
            } catch (IllegalArgumentException e) {
                return ParamCheck.refused(param.id() + " " + e.getMessage());
            }
            values.put(param.id(), checked);
        }
        return ParamCheck.ok(values);
    }

    private static Object check(PanelAction.Param param, JsonPrimitive raw) {
        return switch (param.type()) {
            case TEXT -> {
                if (!raw.isString()) throw new IllegalArgumentException("must be text");
                String text = raw.getAsString();
                if (text.length() > param.maxLength()) {
                    throw new IllegalArgumentException("is longer than " + param.maxLength() + " characters");
                }
                for (int i = 0; i < text.length(); i++) {
                    if (Character.isISOControl(text.charAt(i))) {
                        throw new IllegalArgumentException("must not contain control characters");
                    }
                }
                yield text;
            }
            case NUMBER -> number(param, raw);
            case BOOLEAN -> {
                if (raw.isBoolean()) yield raw.getAsBoolean();
                if (raw.isString() && ("true".equals(raw.getAsString()) || "false".equals(raw.getAsString()))) {
                    yield Boolean.parseBoolean(raw.getAsString());
                }
                throw new IllegalArgumentException("must be true or false");
            }
            case CHOICE -> {
                if (!raw.isString() || !param.choices().contains(raw.getAsString())) {
                    throw new IllegalArgumentException("must be one of " + param.choices());
                }
                yield raw.getAsString();
            }
        };
    }

    private static Object number(PanelAction.Param param, JsonPrimitive raw) {
        BigDecimal number;
        try {
            if (raw.isNumber()) number = raw.getAsBigDecimal();
            else if (raw.isString() && raw.getAsString().length() <= 40) number = new BigDecimal(raw.getAsString().trim());
            else throw new NumberFormatException();
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException("must be a number");
        }
        double value = number.doubleValue();
        if (Double.isNaN(value) || Double.isInfinite(value)) throw new IllegalArgumentException("must be a number");
        if (param.minValue() != null && value < param.minValue()) {
            throw new IllegalArgumentException("must be at least " + param.minValue());
        }
        if (param.maxValue() != null && value > param.maxValue()) {
            throw new IllegalArgumentException("must be at most " + param.maxValue());
        }
        if (!param.isInteger()) return value;
        try {
            return number.longValueExact();
        } catch (ArithmeticException e) {
            throw new IllegalArgumentException("must be a whole number");
        }
    }

    /**
     * Refuses a declared default that would not pass the param's own checks.
     *
     * @throws IllegalArgumentException with the reason
     */
    public static void checkDefault(PanelAction action, PanelAction.Param param) {
        if (param.defaultValue() == null) return;
        try {
            check(param, primitive(param.defaultValue()));
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("default of " + action.id() + "/" + param.id() + " " + e.getMessage());
        }
    }

    private static JsonPrimitive primitive(Object value) {
        if (value instanceof Number number) return new JsonPrimitive(number);
        if (value instanceof Boolean flag) return new JsonPrimitive(flag);
        return new JsonPrimitive(String.valueOf(value));
    }
}
