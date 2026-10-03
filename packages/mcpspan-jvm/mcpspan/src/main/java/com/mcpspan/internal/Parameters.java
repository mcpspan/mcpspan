package com.mcpspan.internal;

import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.Map;

/** Parameter names and JSON types, never values (contract, section 5). Internal: not part of the package's API. */
public final class Parameters {

    /** Bounds one call's description, so a very wide object cannot make a large event. */
    public static final int MAX_DESCRIBED = 50;

    private Parameters() {
    }

    /** The top-level parameters by name and JSON type, or null when there are none. */
    public static Map<String, String> describe(Map<String, ?> arguments) {
        if (arguments == null || arguments.isEmpty()) {
            return null;
        }
        Map<String, String> described = new LinkedHashMap<>();
        for (Map.Entry<String, ?> entry : arguments.entrySet()) {
            if (described.size() >= MAX_DESCRIBED) {
                break;
            }
            described.put(Text.truncate(String.valueOf(entry.getKey()), Text.MAX_NAME), type(entry.getValue()));
        }
        return described;
    }

    private static String type(Object value) {
        if (value == null) {
            return "null";
        }
        if (value instanceof Boolean) {
            return "boolean";
        }
        if (value instanceof Number) {
            return "number";
        }
        if (value instanceof CharSequence) {
            return "string";
        }
        if (value instanceof Map<?, ?>) {
            return "object";
        }
        if (value instanceof Collection<?> || value.getClass().isArray()) {
            return "array";
        }
        return Text.truncate(value.getClass().getSimpleName(), 50);
    }
}
