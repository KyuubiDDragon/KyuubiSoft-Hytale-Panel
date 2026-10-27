package com.kyuubisoft.api.panel;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Objects;

/**
 * The status a {@link PanelInfoProvider} reports: notices at the top, then sections with metric
 * tiles and tables. Immutable; build it with {@link #builder()}.
 *
 * <pre>{@code
 * PanelSnapshot.builder()
 *     .notice(PanelSnapshot.Tone.WARNING, "Database unavailable, data is not saved")
 *     .section(PanelSnapshot.section("Overview")
 *         .metric("Active companions", 12)
 *         .metric(PanelSnapshot.Metric.of("Failed spawns", 2).tone(PanelSnapshot.Tone.WARNING))
 *         .build())
 *     .section(PanelSnapshot.section("Per world")
 *         .table(PanelSnapshot.table("World", "Players", "Pets").row("default", 3, 2).build())
 *         .build())
 *     .build();
 * }</pre>
 *
 * <p>Values (metric values and table cells) may be {@code null}, a {@code Boolean}, a
 * {@code Number} or text; anything else is shown via {@code String.valueOf}. The panel shows text
 * as plain text, never as HTML. Very large snapshots are cut (KyuubiSoftAPI keeps at most 20
 * sections, 30 metrics and 10 tables per section, 16 columns, 200 rows per table, 20 notices and
 * 500 characters per text) and the panel marks cut tables.</p>
 */
public final class PanelSnapshot {

    /** Accent of a notice or metric. */
    public enum Tone { NEUTRAL, INFO, SUCCESS, WARNING, ERROR }

    private final List<Notice> notices;
    private final List<Section> sections;

    private PanelSnapshot(List<Notice> notices, List<Section> sections) {
        this.notices = List.copyOf(notices);
        this.sections = List.copyOf(sections);
    }

    public static Builder builder() {
        return new Builder();
    }

    /** Starts a section; shorthand for {@link Section#builder(String)}. */
    public static Section.Builder section(String title) {
        return Section.builder(title);
    }

    /** Starts a table with these column headers; shorthand for {@link Table#builder(String...)}. */
    public static Table.Builder table(String... columns) {
        return Table.builder(columns);
    }

    public List<Notice> notices() {
        return notices;
    }

    public List<Section> sections() {
        return sections;
    }

    /** Value as the panel receives it: null, Boolean, Number or String. */
    static Object normalizeValue(Object value) {
        if (value == null || value instanceof Boolean || value instanceof String) return value;
        if (value instanceof Double d) return d.isNaN() || d.isInfinite() ? d.toString() : d;
        if (value instanceof Float f) return f.isNaN() || f.isInfinite() ? f.toString() : f;
        if (value instanceof Integer || value instanceof Long || value instanceof Short
                || value instanceof Byte || value instanceof BigDecimal || value instanceof BigInteger) {
            return value;
        }
        if (value instanceof Number number) return number.doubleValue();
        if (value instanceof Enum<?> e) return e.name();
        return String.valueOf(value);
    }

    private static String requireText(String text, String what) {
        Objects.requireNonNull(text, what);
        return text;
    }

    public static final class Builder {
        private final List<Notice> notices = new ArrayList<>();
        private final List<Section> sections = new ArrayList<>();

        private Builder() {}

        /** A highlighted line above the sections, for warnings and errors. */
        public Builder notice(Tone tone, String text) {
            notices.add(new Notice(tone, text));
            return this;
        }

        public Builder section(Section section) {
            sections.add(Objects.requireNonNull(section, "section"));
            return this;
        }

        public PanelSnapshot build() {
            return new PanelSnapshot(notices, sections);
        }
    }

    /** A highlighted line above the sections. */
    public static final class Notice {
        private final Tone tone;
        private final String text;

        private Notice(Tone tone, String text) {
            this.tone = tone == null ? Tone.INFO : tone;
            this.text = requireText(text, "notice text");
        }

        public Tone tone() {
            return tone;
        }

        public String text() {
            return text;
        }
    }

    /** A titled group of metric tiles and tables. */
    public static final class Section {
        private final String title;
        private final String description;
        private final List<Metric> metrics;
        private final List<Table> tables;

        private Section(Builder builder) {
            this.title = builder.title;
            this.description = builder.description;
            this.metrics = List.copyOf(builder.metrics);
            this.tables = List.copyOf(builder.tables);
        }

        public static Builder builder(String title) {
            return new Builder(title);
        }

        public String title() {
            return title;
        }

        /** Short text under the title, or null. */
        public String description() {
            return description;
        }

        public List<Metric> metrics() {
            return metrics;
        }

        public List<Table> tables() {
            return tables;
        }

        public static final class Builder {
            private final String title;
            private String description;
            private final List<Metric> metrics = new ArrayList<>();
            private final List<Table> tables = new ArrayList<>();

            private Builder(String title) {
                this.title = requireText(title, "section title");
            }

            public Builder description(String description) {
                this.description = description;
                return this;
            }

            /** A metric tile with neutral tone. */
            public Builder metric(String label, Object value) {
                return metric(Metric.of(label, value));
            }

            public Builder metric(Metric metric) {
                metrics.add(Objects.requireNonNull(metric, "metric"));
                return this;
            }

            public Builder table(Table table) {
                tables.add(Objects.requireNonNull(table, "table"));
                return this;
            }

            public Section build() {
                return new Section(this);
            }
        }
    }

    /** One tile: label, value and optional unit, hint and tone. Immutable; the setters return copies. */
    public static final class Metric {
        private final String label;
        private final Object value;
        private final String unit;
        private final String hint;
        private final Tone tone;

        private Metric(String label, Object value, String unit, String hint, Tone tone) {
            this.label = requireText(label, "metric label");
            this.value = normalizeValue(value);
            this.unit = unit;
            this.hint = hint;
            this.tone = tone == null ? Tone.NEUTRAL : tone;
        }

        public static Metric of(String label, Object value) {
            return new Metric(label, value, null, null, Tone.NEUTRAL);
        }

        /** Unit shown after the value, for example {@code "ms"}. */
        public Metric unit(String unit) {
            return new Metric(label, value, unit, hint, tone);
        }

        /** Small explanatory text under the value. */
        public Metric hint(String hint) {
            return new Metric(label, value, unit, hint, tone);
        }

        public Metric tone(Tone tone) {
            return new Metric(label, value, unit, hint, tone);
        }

        public String label() {
            return label;
        }

        /** null, Boolean, Number or String. */
        public Object value() {
            return value;
        }

        public String unit() {
            return unit;
        }

        public String hint() {
            return hint;
        }

        public Tone tone() {
            return tone;
        }
    }

    /** A table with column headers and rows of values. */
    public static final class Table {
        private final String title;
        private final List<String> columns;
        private final List<List<Object>> rows;
        private final String emptyText;

        private Table(Builder builder) {
            this.title = builder.title;
            this.columns = List.copyOf(builder.columns);
            List<List<Object>> copy = new ArrayList<>(builder.rows.size());
            for (List<Object> row : builder.rows) {
                copy.add(Collections.unmodifiableList(new ArrayList<>(row)));
            }
            this.rows = Collections.unmodifiableList(copy);
            this.emptyText = builder.emptyText;
        }

        public static Builder builder(String... columns) {
            return new Builder(columns);
        }

        /** Title above the table, or null. */
        public String title() {
            return title;
        }

        public List<String> columns() {
            return columns;
        }

        /** Rows of null/Boolean/Number/String values (may contain nulls). */
        public List<List<Object>> rows() {
            return rows;
        }

        /** Text shown when there are no rows, or null for the panel's default. */
        public String emptyText() {
            return emptyText;
        }

        public static final class Builder {
            private final List<String> columns;
            private final List<List<Object>> rows = new ArrayList<>();
            private String title;
            private String emptyText;

            private Builder(String... columns) {
                Objects.requireNonNull(columns, "columns");
                if (columns.length == 0) throw new IllegalArgumentException("a table needs at least one column");
                for (String column : columns) requireText(column, "column header");
                this.columns = Arrays.asList(columns.clone());
            }

            public Builder title(String title) {
                this.title = title;
                return this;
            }

            /** Adds a row; missing cells are shown empty, extra cells are dropped. */
            public Builder row(Object... cells) {
                List<Object> row = new ArrayList<>(columns.size());
                for (int i = 0; i < columns.size(); i++) {
                    row.add(cells != null && i < cells.length ? normalizeValue(cells[i]) : null);
                }
                rows.add(row);
                return this;
            }

            public Builder emptyText(String emptyText) {
                this.emptyText = emptyText;
                return this;
            }

            public Table build() {
                return new Table(this);
            }
        }
    }
}
