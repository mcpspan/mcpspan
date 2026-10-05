package com.mcpspan.javasdk;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

import com.mcpspan.internal.Definitions;
import io.modelcontextprotocol.json.McpJsonDefaults;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

class DefinitionsTest {

    @AfterEach
    void forget() {
        Definitions.forget();
    }

    @Test
    @SuppressWarnings("unchecked")
    void fingerprintsTheSharedCasesAsEverySdkDoes() throws Exception {
        String raw = Files.readString(Path.of("../../../conformance/definition-hashes.json"));
        Map<String, Object> shared = McpJsonDefaults.getMapper().readValue(raw, Map.class);

        for (Map<String, Object> entry : (List<Map<String, Object>>) shared.get("cases")) {
            assertEquals(entry.get("hash"), Definitions.hash((Map<?, ?>) entry.get("tool")), (String) entry.get("case"));
        }
    }

    @Test
    void keepsTheLatestListedFingerprintOfEachTool() {
        Definitions.note(Map.of("name", "a", "description", "one"));
        Definitions.note(Map.of("name", "b"));
        Definitions.note(Map.of("name", "a", "description", "two"));
        Definitions.note(Map.of("description", "nameless"));

        assertEquals(Definitions.hash(Map.of("name", "a", "description", "two")), Definitions.of("a"));
        assertNotNull(Definitions.of("b"));
        assertNull(Definitions.of("c"));
    }
}
