package com.mcpspan.internal;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

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

    /**
     * The contract's table as cases, shared by every SDK's tests (conformance/client-types.json). The core has no
     * JSON library, and the file is a flat list of pairs of plain strings, so a pattern reads it.
     */
    static Stream<Arguments> contractTable() throws IOException {
        String json = Files.readString(Path.of("../../../conformance/client-types.json"));
        Matcher pair = Pattern.compile("\\[\\s*(null|\"([^\"]*)\")\\s*,\\s*\"([^\"]*)\"\\s*]").matcher(json);
        List<Arguments> cases = new ArrayList<>();
        while (pair.find()) {
            cases.add(Arguments.of(pair.group(2), pair.group(3)));
        }
        assertTrue(cases.size() > 10, "read the table");
        return cases.stream();
    }

    @ParameterizedTest
    @MethodSource("contractTable")
    void detectsTheContractTable(String name, String expected) {
        assertEquals(expected, Clients.detect(name));
    }

    @Test
    void unknownWithoutANameAndTheNameKeptButCut() {
        assertEquals("unknown", Clients.detect(null));
        assertEquals("unknown", Clients.detect("  "));
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
