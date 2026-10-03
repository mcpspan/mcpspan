package com.mcpspan.internal;

import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/** Tools left out of the numbers, by the name they are registered under. Internal: not part of the package's API. */
public final class Exclusions {

    private static final Set<String> NAMES = ConcurrentHashMap.newKeySet();

    private Exclusions() {
    }

    /** Leaves the tool of this name out, refused calls to it included. */
    public static void exclude(String name) {
        if (name != null) {
            NAMES.add(name);
        }
    }

    /** Whether the tool of this name was left out. */
    public static boolean excluded(String name) {
        return name != null && NAMES.contains(name);
    }
}
