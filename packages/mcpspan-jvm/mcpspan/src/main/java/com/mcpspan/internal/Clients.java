package com.mcpspan.internal;

/** The client a call came from, as it named itself (contract, section 7). Internal: not part of the package's API. */
public final class Clients {

    private Clients() {
    }

    /** The name as reported, cut to what the API takes, or null for none. The mcpspan server tells clients apart by it. */
    public static String name(String name) {
        String trimmed = name == null ? "" : name.trim();
        return trimmed.isEmpty() ? null : Text.truncate(trimmed, Text.MAX_NAME);
    }
}
