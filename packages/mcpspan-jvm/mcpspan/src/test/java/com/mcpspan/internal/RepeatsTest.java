package com.mcpspan.internal;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

class RepeatsTest {

    @AfterEach
    void forget() {
        Repeats.forget();
    }

    @Test
    void tellsARepeatOfThePreviousCallToTheToolInTheSessionWhateverTheKeyOrder() {
        Map<String, Object> first = new LinkedHashMap<>();
        first.put("to", "WAW");
        first.put("n", 2);
        Map<String, Object> reordered = new LinkedHashMap<>();
        reordered.put("n", 2);
        reordered.put("to", "WAW");

        assertFalse(Repeats.note("s1", "search", first));
        assertTrue(Repeats.note("s1", "search", reordered));
        assertFalse(Repeats.note("s1", "search", Map.of("to", "KRK")));
        assertFalse(Repeats.note("s1", "book", Map.of("to", "KRK")));
        assertFalse(Repeats.note("s2", "search", Map.of("to", "KRK")));
        assertFalse(Repeats.note("s1", "list", null));
        assertTrue(Repeats.note("s1", "list", Map.of()));
    }

    @Test
    void forgetsTheOldestPairsPastItsBound() {
        Repeats.note("first", "search", Map.of("to", "WAW"));
        for (int i = 0; i < Repeats.MAX_KEPT; i++) {
            Repeats.note("s" + i, "search", null);
        }

        assertFalse(Repeats.note("first", "search", Map.of("to", "WAW")));
    }

    @Test
    void knowsARetryAnsweringAnInterimQuestion() {
        assertTrue(Repeats.continuesEarlierCall(Map.of("requestState", "x")));
        assertTrue(Repeats.continuesEarlierCall(Map.of("inputResponses", Map.of())));
        assertFalse(Repeats.continuesEarlierCall(Map.of("name", "a")));
        assertFalse(Repeats.continuesEarlierCall(null));
    }
}
