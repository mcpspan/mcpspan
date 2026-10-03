package com.mcpspan;

import com.mcpspan.internal.Collector;
import java.time.Duration;

/**
 * Analytics for MCP servers: which tools are called, by which client, how long they take, and which fail.
 *
 * <p>Servers are instrumented through the package for the MCP SDK they are built on, such as
 * {@code com.mcpspan.javasdk.McpSpanJavaSdk}. Without an API key nothing is collected and nothing is sent.
 * Parameter values never leave the process.
 */
public final class McpSpan {

    /** The SDK's own version, reported with every event. */
    public static final String VERSION = com.mcpspan.internal.Version.CURRENT;

    private McpSpan() {
    }

    /**
     * Starts collecting, or stops if there is no key to collect with. The same settings again change nothing;
     * different ones replace the running configuration, delivering what it held. Never throws.
     */
    public static void configure(McpSpanOptions options) {
        Collector.configure(options == null ? McpSpanOptions.defaults() : options);
    }

    /**
     * Stops collecting and delivers what is queued, waiting at most a few seconds. What is queued is also delivered
     * as the JVM shuts down, unless {@link McpSpanOptions#flushOnExit()} is off. Never throws.
     */
    public static void shutdown() {
        Collector.shutdown(Duration.ofSeconds(11));
    }

    /** Whether an API key is configured and calls are being recorded. */
    public static boolean isCollecting() {
        return Collector.collecting();
    }
}
