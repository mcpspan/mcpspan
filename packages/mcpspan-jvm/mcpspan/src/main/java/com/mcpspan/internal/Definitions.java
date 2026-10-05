package com.mcpspan.internal;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Tool definitions as the server lists them, fingerprinted (contract, 3.8). Rewording a description can change how
 * agents use a tool more than a change to its code; the fingerprint is taken from the answer to {@code tools/list},
 * what an agent actually read, and sent with every call to the tool. Kept for the process: one process reports to
 * one server. Internal: not part of the package's API.
 */
public final class Definitions {

    private static final Map<String, String> LISTED = new ConcurrentHashMap<>();

    private static final List<String> HASHED = List.of("name", "title", "description", "inputSchema");

    private Definitions() {
    }

    /** The latest fingerprint listed for a tool, or null when no listing in this process named it. */
    public static String of(String toolName) {
        return toolName == null ? null : LISTED.get(toolName);
    }

    /** Notes one listed tool, in the wire's spelling as plain maps, lists and values. Never throws. */
    public static void note(Map<?, ?> tool) {
        try {
            if (tool != null && tool.get("name") instanceof String name) {
                String hash = hash(tool);
                if (hash != null) {
                    LISTED.put(name, hash);
                }
            }
        }
        catch (RuntimeException ignored) {
            // A listing that cannot be read leaves the fingerprints as they were.
        }
    }

    /** For tests: forgets every listing. */
    public static void forget() {
        LISTED.clear();
    }

    /**
     * The first 16 hex characters of the SHA-256 of the tool's name, title, description and input schema, as
     * canonical JSON; null for a definition that cannot be written so.
     */
    public static String hash(Map<?, ?> tool) {
        try {
            Map<String, Object> hashed = new TreeMap<>();
            for (String field : HASHED) {
                Object value = tool.get(field);
                if (value != null) {
                    hashed.put(field, value);
                }
            }
            StringBuilder text = new StringBuilder();
            canonical(text, hashed);
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(text.toString().getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder();
            for (int i = 0; i < 8; i++) {
                hex.append(String.format("%02x", digest[i]));
            }
            return hex.toString();
        }
        catch (Exception e) {
            return null;
        }
    }

    /** Sorted keys, no whitespace, minimal escaping: the same text in every SDK. */
    private static void canonical(StringBuilder text, Object value) {
        if (value == null) {
            text.append("null");
        }
        else if (value instanceof Boolean flag) {
            text.append(flag);
        }
        else if (value instanceof Integer || value instanceof Long || value instanceof Short || value instanceof Byte
            || value instanceof java.math.BigInteger) {
            text.append(value);
        }
        else if (value instanceof Number number) {
            double d = number.doubleValue();
            if (Double.isNaN(d) || Double.isInfinite(d)) {
                throw new IllegalArgumentException("not a JSON number");
            }
            text.append(d == Math.rint(d) && Math.abs(d) < 1e15 ? Long.toString((long) d) : Double.toString(d));
        }
        else if (value instanceof CharSequence string) {
            text(text, string.toString());
        }
        else if (value instanceof Map<?, ?> map) {
            List<String> keys = new ArrayList<>();
            for (Object key : map.keySet()) {
                keys.add(String.valueOf(key));
            }
            Collections.sort(keys);
            text.append('{');
            boolean first = true;
            for (String key : keys) {
                if (!first) {
                    text.append(',');
                }
                first = false;
                text(text, key);
                text.append(':');
                canonical(text, map.get(key));
            }
            text.append('}');
        }
        else if (value instanceof Iterable<?> items) {
            text.append('[');
            boolean first = true;
            for (Object item : items) {
                if (!first) {
                    text.append(',');
                }
                first = false;
                canonical(text, item);
            }
            text.append(']');
        }
        else {
            throw new IllegalArgumentException("cannot fingerprint " + value.getClass().getName());
        }
    }

    private static void text(StringBuilder text, String value) {
        text.append('"');
        value.codePoints().forEach(c -> {
            switch (c) {
                case '"' -> text.append("\\\"");
                case '\\' -> text.append("\\\\");
                case '\b' -> text.append("\\b");
                case '\f' -> text.append("\\f");
                case '\n' -> text.append("\\n");
                case '\r' -> text.append("\\r");
                case '\t' -> text.append("\\t");
                default -> {
                    if (c < 0x20) {
                        text.append(String.format("\\u%04x", c));
                    }
                    else {
                        text.appendCodePoint(c);
                    }
                }
            }
        });
        text.append('"');
    }
}
