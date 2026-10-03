package com.mcpspan;

import java.time.Duration;
import java.util.Objects;
import java.util.function.Consumer;

/**
 * What the SDK needs to know. Every setting is optional:
 *
 * <pre>{@code
 * McpSpanOptions options = McpSpanOptions.builder()
 *     .apiKey(System.getenv("MCPSPAN_API_KEY"))
 *     .captureParameterNames(true)
 *     .build();
 * }</pre>
 */
public final class McpSpanOptions {

    private final String apiKey;
    private final String endpoint;
    private final boolean debug;
    private final Consumer<String> onDiagnostic;
    private final boolean flushOnExit;
    private final Duration flushInterval;
    private final Integer maxBatchSize;
    private final Integer maxQueueSize;
    private final boolean captureParameterNames;
    private final String serverVersion;

    private McpSpanOptions(Builder builder) {
        this.apiKey = builder.apiKey;
        this.endpoint = builder.endpoint;
        this.debug = builder.debug;
        this.onDiagnostic = builder.onDiagnostic;
        this.flushOnExit = builder.flushOnExit;
        this.flushInterval = builder.flushInterval;
        this.maxBatchSize = builder.maxBatchSize;
        this.maxQueueSize = builder.maxQueueSize;
        this.captureParameterNames = builder.captureParameterNames;
        this.serverVersion = builder.serverVersion;
    }

    /** A builder with every setting at its default. */
    public static Builder builder() {
        return new Builder();
    }

    /** Every setting at its default: the key and endpoint come from the environment. */
    public static McpSpanOptions defaults() {
        return builder().build();
    }

    /** Identifies the server. Falls back to {@code MCPSPAN_API_KEY}; without either, nothing is collected. */
    public String apiKey() { return apiKey; }

    /**
     * Base URL of your mcpspan installation. Falls back to {@code MCPSPAN_ENDPOINT}. There is no default: without
     * either, nothing is collected, and the SDK says so once.
     */
    public String endpoint() { return endpoint; }

    /** Writes delivery diagnostics to standard error. */
    public boolean debug() { return debug; }

    /** Receives diagnostics instead of standard error. Implies {@link #debug()}. */
    public Consumer<String> onDiagnostic() { return onDiagnostic; }

    /** Delivers what is queued as the JVM shuts down. On by default. */
    public boolean flushOnExit() { return flushOnExit; }

    /** How long a partly filled batch waits before being sent. Default five seconds. */
    public Duration flushInterval() { return flushInterval; }

    /** Events in one request. Reaching it sends at once. Default 100. */
    public Integer maxBatchSize() { return maxBatchSize; }

    /** Events held while delivery is failing. Default 10,000. */
    public Integer maxQueueSize() { return maxQueueSize; }

    /** Records parameter names and JSON types. Off by default; values are never read. */
    public boolean captureParameterNames() { return captureParameterNames; }

    /**
     * The version calls are recorded under: a release, a tag, a commit. Falls back to
     * {@code MCPSPAN_SERVER_VERSION}, then to the version the server gives itself ({@code serverInfo}), which is
     * usually all that is needed. The dashboard marks where each one began.
     */
    public String serverVersion() { return serverVersion; }

    @Override
    public boolean equals(Object other) {
        if (!(other instanceof McpSpanOptions o)) {
            return false;
        }
        return debug == o.debug && flushOnExit == o.flushOnExit && captureParameterNames == o.captureParameterNames
            && Objects.equals(apiKey, o.apiKey) && Objects.equals(endpoint, o.endpoint)
            && onDiagnostic == o.onDiagnostic && Objects.equals(flushInterval, o.flushInterval)
            && Objects.equals(maxBatchSize, o.maxBatchSize) && Objects.equals(maxQueueSize, o.maxQueueSize)
            && Objects.equals(serverVersion, o.serverVersion);
    }

    @Override
    public int hashCode() {
        return Objects.hash(apiKey, endpoint, debug, flushOnExit, flushInterval, maxBatchSize, maxQueueSize,
            captureParameterNames, serverVersion);
    }

    /** Builds {@link McpSpanOptions}. */
    public static final class Builder {

        private String apiKey;
        private String endpoint;
        private boolean debug;
        private Consumer<String> onDiagnostic;
        private boolean flushOnExit = true;
        private Duration flushInterval;
        private Integer maxBatchSize;
        private Integer maxQueueSize;
        private boolean captureParameterNames;
        private String serverVersion;

        private Builder() {
        }

        /** See {@link McpSpanOptions#apiKey()}. */
        public Builder apiKey(String value) { this.apiKey = value; return this; }

        /** See {@link McpSpanOptions#endpoint()}. */
        public Builder endpoint(String value) { this.endpoint = value; return this; }

        /** See {@link McpSpanOptions#debug()}. */
        public Builder debug(boolean value) { this.debug = value; return this; }

        /** See {@link McpSpanOptions#onDiagnostic()}. */
        public Builder onDiagnostic(Consumer<String> value) { this.onDiagnostic = value; return this; }

        /** See {@link McpSpanOptions#flushOnExit()}. */
        public Builder flushOnExit(boolean value) { this.flushOnExit = value; return this; }

        /** See {@link McpSpanOptions#flushInterval()}. */
        public Builder flushInterval(Duration value) { this.flushInterval = value; return this; }

        /** See {@link McpSpanOptions#maxBatchSize()}. */
        public Builder maxBatchSize(int value) { this.maxBatchSize = value; return this; }

        /** See {@link McpSpanOptions#maxQueueSize()}. */
        public Builder maxQueueSize(int value) { this.maxQueueSize = value; return this; }

        /** See {@link McpSpanOptions#captureParameterNames()}. */
        public Builder captureParameterNames(boolean value) { this.captureParameterNames = value; return this; }

        /** See {@link McpSpanOptions#serverVersion()}. */
        public Builder serverVersion(String value) { this.serverVersion = value; return this; }

        /** The options, as set so far. */
        public McpSpanOptions build() {
            return new McpSpanOptions(this);
        }
    }
}
