package com.mcpspan.internal;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Whether a call repeats the previous call to the same tool in the same session (contract, 3.9): an agent stuck in a
 * loop. Only the answer leaves the process. Kept here is a SHA-256 of the canonical arguments of the latest call per
 * session and tool, never sent: a digest of a short identifier or an enumerated value is found by trying every one.
 * Internal: not part of the package's API.
 */
public final class Repeats {

    /** Session and tool pairs kept, the oldest forgotten first. */
    public static final int MAX_KEPT = 10_000;

    /** In access order, so the eldest entry is the one longest unused. */
    private static final Map<List<String>, byte[]> LATEST = new LinkedHashMap<>(16, 0.75f, true) {
        @Override
        protected boolean removeEldestEntry(Map.Entry<List<String>, byte[]> eldest) {
            return size() > MAX_KEPT;
        }
    };

    private Repeats() {
    }

    /**
     * Notes a call's arguments, as the client sent them, and says whether they are the previous call's to the same
     * tool in the same session. Arguments that cannot be written down are never a repeat. Never throws.
     */
    public static boolean note(String sessionId, String toolName, Map<String, ?> arguments) {
        byte[] digest;
        try {
            String text = Definitions.canonicalText(arguments == null ? Map.of() : arguments);
            digest = MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8));
        }
        catch (Exception e) {
            return false;
        }
        synchronized (LATEST) {
            byte[] previous = LATEST.put(List.of(sessionId, toolName == null ? "" : toolName), digest);
            return previous != null && Arrays.equals(previous, digest);
        }
    }

    /**
     * Whether a call's parameters answer an interim result's question (2026-07-28): the call then continues the one
     * that asked, and is neither compared nor kept.
     */
    public static boolean continuesEarlierCall(Object params) {
        return params instanceof Map<?, ?> map
            && (present(map.get("inputResponses")) || present(map.get("requestState")));
    }

    private static boolean present(Object value) {
        return value != null && !"".equals(value);
    }

    /** For tests: forgets every call. */
    public static void forget() {
        synchronized (LATEST) {
            LATEST.clear();
        }
    }
}
