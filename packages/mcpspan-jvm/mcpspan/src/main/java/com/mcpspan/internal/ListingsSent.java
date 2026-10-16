package com.mcpspan.internal;

import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

/**
 * The listings already sent for each session, so the same answer to {@code tools/list} is sent once per session
 * (contract, 3.11). A client lists the tools at the start of a session and often again; the count that matters is
 * the sessions that were shown the tools, not how often they asked. Internal: not part of the package's API.
 */
public final class ListingsSent {

    /** Sessions kept, the oldest forgotten first. */
    private static final int MAX_SESSIONS = 10_000;

    private static final Map<String, Set<String>> SENT = new LinkedHashMap<>(16, 0.75f, true) {
        private static final long serialVersionUID = 1L;

        @Override
        protected boolean removeEldestEntry(Map.Entry<String, Set<String>> eldest) {
            return size() > MAX_SESSIONS;
        }
    };

    private ListingsSent() {
    }

    /** Whether a listing is new for its session, noting it as sent. One with no session always is. */
    public static boolean first(String sessionId, String signature) {
        if (sessionId == null) {
            return true;
        }
        synchronized (SENT) {
            return SENT.computeIfAbsent(sessionId, key -> new HashSet<>()).add(signature);
        }
    }

    /** For tests: forgets every listing sent. */
    public static void forget() {
        synchronized (SENT) {
            SENT.clear();
        }
    }
}
