package com.mcpspan.internal;

import java.util.Locale;

/** Client types, as the contract names them (section 7). Internal: not part of the package's API. */
public final class Clients {

    // claude-code before claude, which would otherwise swallow it. The official
    // Inspector sends inspector-cli, which is why names are matched as substrings.
    private static final String[][] KNOWN = {
        {"claude-code", "claude-code"},
        {"claude code", "claude-code"},
        {"claude", "claude"},
        {"cursor", "cursor"},
        {"chatgpt", "chatgpt"},
        {"openai", "chatgpt"},
        {"inspector", "mcp-inspector"},
    };

    private Clients() {
    }

    /** The client type, from the name a client reported: substring match, first match wins. */
    public static String detect(String name) {
        String lower = name == null ? "" : name.trim().toLowerCase(Locale.ROOT);
        if (lower.isEmpty()) {
            return "unknown";
        }
        for (String[] known : KNOWN) {
            if (lower.contains(known[0])) {
                return known[1];
            }
        }
        return "other";
    }

    /** The name as reported, cut to what the API takes, or null for none. */
    public static String name(String name) {
        String trimmed = name == null ? "" : name.trim();
        return trimmed.isEmpty() ? null : Text.truncate(trimmed, Text.MAX_NAME);
    }
}
