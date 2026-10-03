package com.mcpspan.internal;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.WeakHashMap;

/**
 * Which conversation a call belongs to (contract, section 8). The identifier is ours, random, and never derived
 * from the transport's own, which travels in HTTP headers and would let server logs be joined to it. Internal:
 * not part of the package's API.
 */
public final class Sessions {

    static final int MAX_PER_CONNECTION = 1_000;

    // Weakly keyed by the connection object, so a connection that ends takes its entry with it.
    private static final Map<Object, Map<String, String>> BY_CONNECTION = new WeakHashMap<>();

    private Sessions() {
    }

    /**
     * Our identifier for a call, or null for none: over HTTP without a transport session (stateless, and every
     * endpoint on 2026-07-28) there is none; otherwise one per connection and transport session.
     */
    public static String of(Object connection, boolean overHttp, String transportSession) {
        if (overHttp && (transportSession == null || transportSession.isEmpty())) {
            return null;
        }
        String key = transportSession == null ? "" : transportSession;
        synchronized (BY_CONNECTION) {
            Map<String, String> known = BY_CONNECTION.computeIfAbsent(connection, c -> new LinkedHashMap<>(16, 0.75f, true) {
                private static final long serialVersionUID = 1L;

                @Override
                protected boolean removeEldestEntry(Map.Entry<String, String> eldest) {
                    return size() > MAX_PER_CONNECTION;
                }
            });
            return known.computeIfAbsent(key, k -> UUID.randomUUID().toString());
        }
    }
}
