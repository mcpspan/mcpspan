package com.mcpspan.javasdk;

import io.modelcontextprotocol.json.McpJsonDefaults;
import io.modelcontextprotocol.json.McpJsonMapper;

/**
 * How large an answer is, in bytes of its JSON as the MCP SDK writes it (contract, 3.7). The JSON is counted and
 * dropped; nothing of it is kept or sent.
 */
final class Sizes {

    /** The largest size an event carries; anything larger is sent as this. */
    static final long MAX = Integer.MAX_VALUE;

    private static volatile McpJsonMapper mapper;

    private Sizes() {
    }

    /** The size of an answer, or null when there is none or it cannot be written. */
    static Long of(Object answer) {
        if (answer == null) {
            return null;
        }
        try {
            McpJsonMapper current = mapper;
            if (current == null) {
                current = McpJsonDefaults.getMapper();
                mapper = current;
            }
            return Math.min(current.writeValueAsBytes(answer).length, MAX);
        }
        catch (Exception | LinkageError e) {
            return null;
        }
    }
}
