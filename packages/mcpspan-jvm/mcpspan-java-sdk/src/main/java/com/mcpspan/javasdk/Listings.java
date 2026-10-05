package com.mcpspan.javasdk;

import com.mcpspan.internal.Collector;
import com.mcpspan.internal.Definitions;
import io.modelcontextprotocol.json.McpJsonDefaults;
import io.modelcontextprotocol.server.McpRequestHandler;
import io.modelcontextprotocol.spec.McpSchema;
import java.util.Map;

/** Notes the tools each {@code tools/list} answer describes, for the fingerprint each call carries (contract, 3.8). */
final class Listings {

    private Listings() {
    }

    static McpRequestHandler<Object> handler(McpRequestHandler<Object> original) {
        return (exchange, params) -> original.handle(exchange, params).doOnNext(Listings::note);
    }

    private static void note(Object result) {
        try {
            if (Collector.collecting() && result instanceof McpSchema.ListToolsResult listing && listing.tools() != null) {
                for (McpSchema.Tool tool : listing.tools()) {
                    // The tool in the wire's spelling, as the SDK writes it to the client.
                    Definitions.note(McpJsonDefaults.getMapper().convertValue(tool, Map.class));
                }
            }
        }
        catch (RuntimeException | LinkageError ignored) {
            // Looking at a listing must never change it.
        }
    }
}
