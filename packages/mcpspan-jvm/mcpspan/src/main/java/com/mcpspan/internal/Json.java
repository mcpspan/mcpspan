package com.mcpspan.internal;

/** Just enough JSON writing for the event, so the core needs no library. Internal: not part of the package's API. */
final class Json {

    private Json() {
    }

    /** Appends {@code "name":"value"}, preceded by a comma unless first; nothing at all for a null value. */
    static void field(StringBuilder json, String name, String value, boolean first) {
        if (value == null) {
            return;
        }
        if (!first) {
            json.append(',');
        }
        string(json, name);
        json.append(':');
        string(json, value);
    }

    static void string(StringBuilder json, String value) {
        json.append('"');
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"' -> json.append("\\\"");
                case '\\' -> json.append("\\\\");
                case '\n' -> json.append("\\n");
                case '\r' -> json.append("\\r");
                case '\t' -> json.append("\\t");
                default -> {
                    if (c < 0x20) {
                        json.append(String.format("\\u%04x", (int) c));
                    }
                    else {
                        json.append(c);
                    }
                }
            }
        }
        json.append('"');
    }
}
