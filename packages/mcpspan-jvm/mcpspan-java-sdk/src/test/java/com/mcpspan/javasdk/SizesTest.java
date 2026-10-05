package com.mcpspan.javasdk;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import io.modelcontextprotocol.json.McpJsonDefaults;
import io.modelcontextprotocol.spec.McpSchema;
import java.util.List;
import org.junit.jupiter.api.Test;

class SizesTest {

    @Test
    void measuresAnAnswerAsTheSdkWritesIt() throws Exception {
        McpSchema.CallToolResult result = McpSchema.CallToolResult.builder()
            .content(List.of(McpSchema.TextContent.builder("Zażółć ✈️ " + "x".repeat(1000)).build()))
            .build();

        assertEquals((long) McpJsonDefaults.getMapper().writeValueAsBytes(result).length, Sizes.of(result));
    }

    @Test
    void hasNoSizeForNoAnswer() {
        assertNull(Sizes.of(null));
    }
}
