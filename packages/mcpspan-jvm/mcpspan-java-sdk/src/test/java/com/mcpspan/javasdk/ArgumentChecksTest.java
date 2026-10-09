package com.mcpspan.javasdk;

import static org.junit.jupiter.api.Assertions.assertEquals;

import com.mcpspan.internal.ArgumentChecks;
import io.modelcontextprotocol.json.McpJsonDefaults;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class ArgumentChecksTest {

    @Test
    @SuppressWarnings("unchecked")
    void findsTheSharedCasesAsEverySdkDoes() throws Exception {
        String raw = Files.readString(Path.of("../../../conformance/argument-checks.json"));
        Map<String, Object> shared = McpJsonDefaults.getMapper().readValue(raw, Map.class);

        for (Map<String, Object> entry : (List<Map<String, Object>>) shared.get("cases")) {
            assertEquals(entry.get("invalid"), ArgumentChecks.invalid(entry.get("schema"), entry.get("arguments")),
                (String) entry.get("case"));
        }
    }

    @Test
    void findsNothingWithoutASchema() {
        assertEquals(List.of(), ArgumentChecks.invalid(null, Map.of("passengers", 2)));
    }
}
