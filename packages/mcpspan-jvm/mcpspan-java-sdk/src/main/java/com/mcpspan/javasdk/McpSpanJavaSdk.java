package com.mcpspan.javasdk;

import com.mcpspan.McpSpan;
import com.mcpspan.McpSpanOptions;
import com.mcpspan.internal.Collector;
import com.mcpspan.internal.Exclusions;
import io.modelcontextprotocol.server.McpAsyncServer;
import io.modelcontextprotocol.server.McpServerFeatures.AsyncToolSpecification;
import io.modelcontextprotocol.server.McpServerFeatures.SyncToolSpecification;
import io.modelcontextprotocol.server.McpSyncServer;
import io.modelcontextprotocol.spec.McpServerTransportProvider;

/**
 * Instruments servers built on the official MCP Java SDK, {@code io.modelcontextprotocol.sdk}.
 *
 * <pre>{@code
 * McpSyncServer server = McpServer.sync(transport).serverInfo("flights", "1.0.0").tools(search).build();
 * McpSpanJavaSdk.instrument(server, McpSpanOptions.builder().apiKey(System.getenv("MCPSPAN_API_KEY")).build());
 * }</pre>
 */
public final class McpSpanJavaSdk {

    private McpSpanJavaSdk() {
    }

    /**
     * Instruments the server that will be built on this transport, from its first session's first message, and
     * returns the transport to build it on. The way to instrument a stdio server:
     *
     * <pre>{@code
     * McpSyncServer server = McpServer.sync(McpSpanJavaSdk.instrument(new StdioServerTransportProvider(mapper)))
     *     .tools(search)
     *     .build();
     * }</pre>
     *
     * <p>A stdio transport starts reading as the server is built, so instrumenting the server afterwards can miss
     * the first calls of a fast client; instrumenting the transport cannot. Configures from the environment unless
     * {@link McpSpan#configure} ran already. Never throws.
     */
    public static McpServerTransportProvider instrument(McpServerTransportProvider transport) {
        return instrument(transport, null);
    }

    /** As {@link #instrument(McpServerTransportProvider)}, applying the options first. */
    public static McpServerTransportProvider instrument(McpServerTransportProvider transport, McpSpanOptions options) {
        configureFor(options);
        return transport == null || transport instanceof InstrumentedTransport ? transport
            : new InstrumentedTransport(transport);
    }

    /**
     * Measures every tool call the server answers, from tools it was built with and tools added later, and returns
     * the server. For a server on a stdio transport, instrument the transport instead, so the first calls are not
     * missed while the server is being built. Configures from the environment unless {@link McpSpan#configure} ran already. Never throws.
     */
    public static McpSyncServer instrument(McpSyncServer server) {
        return instrument(server, null);
    }

    /**
     * As {@link #instrument(McpSyncServer)}, applying the options first, as {@link McpSpan#configure} does.
     */
    public static McpSyncServer instrument(McpSyncServer server, McpSpanOptions options) {
        configureFor(options);
        if (server != null) {
            try {
                Instrumentation.instrument(server.getAsyncServer());
            }
            catch (RuntimeException ignored) {
                // An unfamiliar server is left exactly as it was.
            }
        }
        return server;
    }

    /** As {@link #instrument(McpSyncServer)}, for an asynchronous server. */
    public static McpAsyncServer instrument(McpAsyncServer server) {
        return instrument(server, null);
    }

    /** As {@link #instrument(McpSyncServer, McpSpanOptions)}, for an asynchronous server. */
    public static McpAsyncServer instrument(McpAsyncServer server, McpSpanOptions options) {
        configureFor(options);
        if (server != null) {
            try {
                Instrumentation.instrument(server);
            }
            catch (RuntimeException ignored) {
                // An unfamiliar server is left exactly as it was.
            }
        }
        return server;
    }

    /**
     * Records every call to one tool, for a server {@code instrument} does not cover. On an instrumented server it
     * records nothing itself, and each call is counted once.
     */
    public static SyncToolSpecification track(SyncToolSpecification tool) {
        return Instrumentation.track(tool);
    }

    /** As {@link #track(SyncToolSpecification)}, for an asynchronous tool. */
    public static AsyncToolSpecification track(AsyncToolSpecification tool) {
        return Instrumentation.track(tool);
    }

    /**
     * Leaves a tool out of the numbers entirely, refused calls to it included, and returns it as given. For tools
     * called by machinery rather than agents, such as a health check. It reads the name from the tool itself, so a
     * rename carries the exclusion along.
     */
    public static SyncToolSpecification exclude(SyncToolSpecification tool) {
        if (tool != null && tool.tool() != null) {
            Exclusions.exclude(tool.tool().name());
        }
        return tool;
    }

    /** As {@link #exclude(SyncToolSpecification)}, for an asynchronous tool. */
    public static AsyncToolSpecification exclude(AsyncToolSpecification tool) {
        if (tool != null && tool.tool() != null) {
            Exclusions.exclude(tool.tool().name());
        }
        return tool;
    }

    private static void configureFor(McpSpanOptions options) {
        if (options != null) {
            McpSpan.configure(options);
        }
        else if (!Collector.collecting()) {
            McpSpan.configure(McpSpanOptions.defaults());
        }
    }
}
