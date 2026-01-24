package com.kyuubisoft.api.handlers;

import com.kyuubisoft.api.metrics.PrometheusMetrics;

/**
 * Handler for the /metrics endpoint that returns Prometheus format metrics.
 */
public class MetricsHandler {

    private static final String CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

    private final PrometheusMetrics prometheusMetrics;

    public MetricsHandler(PrometheusMetrics prometheusMetrics) {
        this.prometheusMetrics = prometheusMetrics;
    }

    /**
     * Generate Prometheus text format metrics.
     * @return Prometheus metrics as string
     */
    public String getMetrics() {
        return prometheusMetrics.generateMetrics();
    }

    /**
     * Get the content type for the metrics response.
     */
    public String getContentType() {
        return CONTENT_TYPE;
    }
}
