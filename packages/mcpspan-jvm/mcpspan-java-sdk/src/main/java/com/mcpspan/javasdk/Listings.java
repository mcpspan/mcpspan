package com.mcpspan.javasdk;

import com.mcpspan.internal.Call;
import com.mcpspan.internal.Collector;
import com.mcpspan.internal.Definitions;
import com.mcpspan.internal.Sessions;
import com.mcpspan.internal.ToolCallEvent;
import io.modelcontextprotocol.json.McpJsonDefaults;
import io.modelcontextprotocol.server.McpAsyncServer;
import io.modelcontextprotocol.server.McpAsyncServerExchange;
import io.modelcontextprotocol.server.McpRequestHandler;
import io.modelcontextprotocol.spec.McpSchema;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Notes the tools each {@code tools/list} answer describes, for the fingerprint each call carries (contract, 3.8),
 * and records the answer itself (3.11).
 */
final class Listings {

    private Listings() {
    }

    static McpRequestHandler<Object> handler(McpAsyncServer server, McpRequestHandler<Object> original) {
        return (exchange, params) -> original.handle(exchange, params)
            .doOnNext(result -> record(server, exchange, params, result));
    }

    private static void record(McpAsyncServer server, McpAsyncServerExchange exchange, Object params, Object result) {
        try {
            if (Collector.collecting() && result instanceof McpSchema.ListToolsResult listing && listing.tools() != null) {
                List<ToolCallEvent.ListedTool> listed = new ArrayList<>();
                for (McpSchema.Tool tool : listing.tools()) {
                    // The tool in the wire's spelling, as the SDK writes it to the client.
                    ToolCallEvent.ListedTool written = Definitions.note(McpJsonDefaults.getMapper().convertValue(tool, Map.class));
                    if (written != null) {
                        listed.add(written);
                    }
                }

                Instrumentation.Client client = Instrumentation.clientOf(
                    Instrumentation.metaOf(params), exchange != null ? exchange.getClientInfo() : null);
                String session = exchange != null && exchange.sessionId() != null
                    ? Sessions.of(server, false, exchange.sessionId())
                    : null;
                new Call(ToolCallEvent.LISTING, "tools/list", client.name(), session, null, null)
                    .versions(client.version(), Instrumentation.serverVersionOf(server))
                    .listed(listed);
            }
        }
        catch (RuntimeException | LinkageError ignored) {
            // Looking at a listing must never change it.
        }
    }
}
