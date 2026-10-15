package com.mcpspan.internal;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class TextTest {

    static final class BookingException extends RuntimeException {
        private static final long serialVersionUID = 1L;

        BookingException(String message) {
            super(message);
        }
    }

    @Test
    void truncateMarksACutAndKeepsCharactersWhole() {
        assertEquals("abc", Text.truncate("abc", 5));
        assertEquals("ab...", Text.truncate("abcdefgh", 5));
        String cut = Text.truncate("😀".repeat(300), 200);
        assertEquals(200, cut.codePointCount(0, cut.length()));
        assertTrue(cut.endsWith("..."));
    }

    @Test
    void describesAnExceptionByItsClassAndMessage() {
        assertEquals("BookingException", Text.errorType(new BookingException("boom")));
        assertEquals("boom", Text.errorMessage(new BookingException("boom")));
        assertNull(Text.errorMessage(new IllegalStateException()));
        assertEquals(500, Text.errorMessage(new IllegalStateException("m".repeat(1000))).length());
    }

    @Test
    void joinsResultTextAndCutsIt() {
        assertEquals("No flights found", Text.resultMessage(List.of("No flights", "found")));
        assertNull(Text.resultMessage(List.of()));
        assertEquals(200, Text.resultMessage(List.of("x".repeat(1000))).length());
    }

    @Test
    void theNameKeptButCut() {
        assertNull(Clients.name("  "));
        assertEquals("cursor", Clients.name(" cursor "));
        assertEquals(200, Clients.name("c".repeat(400)).length());
    }

    @Test
    void describesParametersByNameAndJsonTypeOnly() {
        Map<String, Object> arguments = new LinkedHashMap<>();
        arguments.put("destination", "secret");
        arguments.put("passengers", 2);
        arguments.put("direct", true);
        arguments.put("stops", List.of());
        arguments.put("filters", Map.of());
        arguments.put("note", null);

        Map<String, String> described = Parameters.describe(arguments);

        assertEquals(Map.of("destination", "string", "passengers", "number", "direct", "boolean",
            "stops", "array", "filters", "object", "note", "null"), described);
        assertFalse(described.values().contains("secret"));
        assertNull(Parameters.describe(Map.of()));
    }

    @Test
    void boundsTheParametersDescribed() {
        Map<String, Object> wide = new LinkedHashMap<>();
        for (int i = 0; i < 80; i++) {
            wide.put("p" + i, i);
        }
        assertEquals(Parameters.MAX_DESCRIBED, Parameters.describe(wide).size());
    }
}
