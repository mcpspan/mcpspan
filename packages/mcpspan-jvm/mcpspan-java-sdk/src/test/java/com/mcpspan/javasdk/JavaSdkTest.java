package com.mcpspan.javasdk;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.mcpspan.McpSpan;
import com.mcpspan.McpSpanOptions;
import com.mcpspan.internal.Collector;
import com.mcpspan.internal.ToolCallEvent;
import io.modelcontextprotocol.server.McpServer;
import io.modelcontextprotocol.server.McpServerFeatures;
import io.modelcontextprotocol.server.McpServerFeatures.SyncToolSpecification;
import io.modelcontextprotocol.server.McpSyncServer;
import io.modelcontextprotocol.spec.McpSchema;
import io.modelcontextprotocol.spec.McpSchema.CallToolResult;
import io.modelcontextprotocol.spec.McpSchema.TextContent;
import io.modelcontextprotocol.spec.McpSchema.Tool;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class JavaSdkTest {

    static final class BookingException extends RuntimeException {
        private static final long serialVersionUID = 1L;

        BookingException(String message) {
            super(message);
        }
    }

    private final List<ToolCallEvent> events = new ArrayList<>();

    @BeforeEach
    void capture() {
        Collector.useSender(batch -> {
            synchronized (events) {
                events.addAll(batch);
            }
        });
        McpSpan.configure(McpSpanOptions.builder().apiKey("k").flushInterval(Duration.ofHours(1)).build());
    }

    @AfterEach
    void reset() {
        McpSpan.shutdown();
        Collector.useSender(null);
    }

    private List<ToolCallEvent> delivered() {
        McpSpan.shutdown();
        synchronized (events) {
            return List.copyOf(events);
        }
    }

    private static Map<String, ToolCallEvent> byTool(List<ToolCallEvent> events) {
        return events.stream().collect(Collectors.toMap(ToolCallEvent::toolName, Function.identity(), (a, b) -> b));
    }

    private static final Map<String, Object> NO_INPUT = Map.of("type", "object");
    private static final Map<String, Object> TYPED = Map.of(
        "type", "object",
        "properties", Map.of("destination", Map.of("type", "string"), "passengers", Map.of("type", "number")),
        "required", List.of("destination", "passengers"));

    private static SyncToolSpecification tool(String name, Map<String, Object> schema,
                                              java.util.function.Supplier<CallToolResult> answer) {
        return SyncToolSpecification.builder()
            .tool(Tool.builder(name, schema).build())
            .callHandler((exchange, request) -> answer.get())
            .build();
    }

    private static CallToolResult text(String value, boolean error) {
        return CallToolResult.builder().content(List.of(TextContent.builder(value).build())).isError(error).build();
    }

    private static SyncToolSpecification[] flightTools() {
        return new SyncToolSpecification[] {
            tool("ok", NO_INPUT, () -> text("ok", false)),
            tool("reported_error", NO_INPUT, () -> text("No flights found", true)),
            tool("throws", NO_INPUT, () -> {
                throw new BookingException("seat map unavailable");
            }),
            tool("typed", TYPED, () -> text("ok", false)),
            McpSpanJavaSdk.exclude(tool("health", TYPED, () -> text("ok", false))),
        };
    }

    private static McpSyncServer server(io.modelcontextprotocol.spec.McpServerTransportProvider transport,
                                        SyncToolSpecification... tools) {
        return McpServer.sync(transport)
            .serverInfo("test", "1.4.0")
            .capabilities(McpSchema.ServerCapabilities.builder().tools(true).build())
            .tools(tools)
            .build();
    }

    @Test
    void recordsEachKindOfOutcomeAndLeavesTheAnswersAlone() throws Exception {
        try (Wire wire = new Wire()) {
            server(McpSpanJavaSdk.instrument(wire.transport), flightTools());
            wire.connect("claude-code");

            assertNotNull(wire.call("ok").get("result"));
            wire.call("reported_error");
            Map<String, Object> thrown = wire.call("throws");
            assertNotNull(thrown.get("error"), "the client still gets the error, as without mcpspan");
        }

        Map<String, ToolCallEvent> recorded = byTool(delivered());
        assertTrue(recorded.get("ok").success());
        assertEquals("result", recorded.get("reported_error").errorSource());
        assertEquals("No flights found", recorded.get("reported_error").errorMessage());
        assertEquals("exception", recorded.get("throws").errorSource());
        assertEquals("BookingException", recorded.get("throws").errorType());
        assertEquals("seat map unavailable", recorded.get("throws").errorMessage());
    }

    @Test
    void recordsRefusedCallsWithoutAMessage() throws Exception {
        try (Wire wire = new Wire()) {
            server(McpSpanJavaSdk.instrument(wire.transport), flightTools());
            wire.connect("claude-code");

            wire.call("typed", Map.of("destination", "WAW", "passengers", "two"));
            wire.call("no_such_tool");
        }

        Map<String, ToolCallEvent> recorded = byTool(delivered());
        assertEquals("arguments", recorded.get("typed").errorSource());
        assertNull(recorded.get("typed").errorMessage());
        assertEquals("unknown_tool", recorded.get("no_such_tool").errorSource());
        assertNull(recorded.get("no_such_tool").errorMessage());
    }

    @Test
    void leavesAnExcludedToolOutEvenWhenRefused() throws Exception {
        try (Wire wire = new Wire()) {
            server(McpSpanJavaSdk.instrument(wire.transport), flightTools());
            wire.connect("claude-code");

            wire.call("health", Map.of("destination", "WAW", "passengers", 1));
            wire.call("health", Map.of("destination", 1));
            wire.call("ok");
        }

        assertEquals(List.of("ok"), delivered().stream().map(ToolCallEvent::toolName).toList());
    }

    @Test
    void theClientAndOneSessionPerConnection() throws Exception {
        try (Wire wire = new Wire()) {
            server(McpSpanJavaSdk.instrument(wire.transport), flightTools());
            wire.connect("Claude Desktop");

            wire.call("ok");
            wire.call("typed", Map.of());
            wire.call("no_such_tool");
        }

        List<ToolCallEvent> recorded = delivered();
        assertEquals(3, recorded.size());
        assertTrue(recorded.stream().allMatch(e -> "claude".equals(e.clientType()) && "Claude Desktop".equals(e.clientName())));
        assertEquals(1, recorded.stream().map(ToolCallEvent::sessionId).distinct().count());
        assertNotNull(recorded.get(0).sessionId());
    }

    @Test
    void theServersOwnVersionAndTheClients() throws Exception {
        try (Wire wire = new Wire()) {
            server(McpSpanJavaSdk.instrument(wire.transport), flightTools());
            wire.connect("cursor");
            wire.call("ok");
            wire.call("no_such_tool");
        }

        List<ToolCallEvent> recorded = delivered();
        assertEquals(2, recorded.size());
        assertTrue(recorded.stream().allMatch(e -> "1.4.0".equals(e.serverVersion()) && "1.0.0".equals(e.clientVersion())));
    }

    @Test
    void aServerVersionSetForTheSdkWinsOverTheServersOwn() throws Exception {
        McpSpan.configure(McpSpanOptions.builder().apiKey("k").flushInterval(Duration.ofHours(1))
            .serverVersion("abc123").build());
        try (Wire wire = new Wire()) {
            server(McpSpanJavaSdk.instrument(wire.transport), flightTools());
            wire.connect("cursor");
            wire.call("ok");
        }

        assertEquals("abc123", delivered().get(0).serverVersion());
    }

    @Test
    void instrumentingTheServerMeasuresToolsAddedAfterAsWell() throws Exception {
        try (Wire wire = new Wire()) {
            McpSyncServer server = server(wire.transport, flightTools());
            McpSpanJavaSdk.instrument(server);
            wire.connect("claude-code");
            // Added once the client is connected and nothing is in flight: the MCP SDK announces the new tool,
            // and an announcement queued before the handshake can race the handshake's own answer.
            server.addTool(tool("later", NO_INPUT, () -> text("later", false)));

            wire.call("ok");
            wire.call("later");
            wire.call("typed", Map.of());
        }

        assertEquals(List.of("ok", "later", "typed"), delivered().stream().map(ToolCallEvent::toolName).toList());
    }

    @Test
    void recordsParameterNamesAndTypesAndNeverAValue() throws Exception {
        McpSpan.configure(McpSpanOptions.builder().apiKey("k").flushInterval(Duration.ofHours(1))
            .captureParameterNames(true).build());
        try (Wire wire = new Wire()) {
            server(McpSpanJavaSdk.instrument(wire.transport), flightTools());
            wire.connect("claude-code");

            wire.call("typed", Map.of("destination", "secret", "passengers", 2));
            wire.call("typed", Map.of("dest", "secret", "passengers", "two"));
        }

        List<ToolCallEvent> recorded = delivered();
        assertEquals(Map.of("destination", "string", "passengers", "number"), recorded.get(0).parameters());
        assertEquals(Map.of("dest", "string", "passengers", "string"), recorded.get(1).parameters());
        assertFalse(recorded.toString().contains("secret"));
    }

    @Test
    void aToolTrackedByHandCountsOnceAndAloneStillCounts() throws Exception {
        SyncToolSpecification byHand = McpSpanJavaSdk.track(tool("by_hand", NO_INPUT, () -> text("ok", false)));

        try (Wire wire = new Wire()) {
            server(McpSpanJavaSdk.instrument(wire.transport), byHand);
            wire.connect("claude-code");
            wire.call("by_hand");
        }
        try (Wire wire = new Wire()) {
            server(wire.transport, byHand);
            wire.connect("cursor");
            wire.call("by_hand");
        }

        List<ToolCallEvent> recorded = delivered();
        assertEquals(List.of("claude-code", "cursor"), recorded.stream().map(ToolCallEvent::clientType).toList());
    }

    @Test
    void unconfiguredTheServerWorksAndNothingIsRecorded() throws Exception {
        McpSpan.shutdown();
        try (Wire wire = new Wire()) {
            server(McpSpanJavaSdk.instrument(wire.transport), flightTools());
            wire.connect("claude-code");
            assertNotNull(wire.call("ok").get("result"));
        }
        assertFalse(McpSpan.isCollecting());
        assertTrue(delivered().isEmpty());
    }

    @Test
    void instrumentNeverThrowsAndReturnsWhatItWasGiven() {
        assertNull(McpSpanJavaSdk.instrument((McpSyncServer) null));
        assertNull(McpSpanJavaSdk.instrument((io.modelcontextprotocol.spec.McpServerTransportProvider) null));
    }

    @Test
    void recordsResourcesAndPromptsByWhatTheyAre() throws Exception {
        McpSpan.configure(McpSpanOptions.builder().apiKey("k").flushInterval(Duration.ofHours(1))
            .captureParameterNames(true).build());
        BiFunctionRead read = (exchange, request) -> McpSchema.ReadResourceResult.builder(
            List.of(McpSchema.TextResourceContents.builder(request.uri(), "ok").build())).build();

        try (Wire wire = new Wire()) {
            McpServer.sync(McpSpanJavaSdk.instrument(wire.transport))
                .serverInfo("test", "1.0.0")
                .capabilities(McpSchema.ServerCapabilities.builder().resources(false, false).prompts(false).build())
                .resources(new McpServerFeatures.SyncResourceSpecification(
                    McpSchema.Resource.builder("config://app", "config").build(), read::apply))
                .resourceTemplates(new McpServerFeatures.SyncResourceTemplateSpecification(
                    McpSchema.ResourceTemplate.builder("trips://{id}", "trip").build(), read::apply))
                .prompts(
                    new McpServerFeatures.SyncPromptSpecification(McpSchema.Prompt.builder("plan_trip").build(),
                        (exchange, request) -> McpSchema.GetPromptResult.builder(List.of()).build()),
                    new McpServerFeatures.SyncPromptSpecification(McpSchema.Prompt.builder("broken").build(),
                        (exchange, request) -> {
                            throw new BookingException("no planner");
                        }))
                .build();
            wire.connect("cursor");

            wire.request("resources/read", Map.of("uri", "config://app"));
            wire.request("resources/read", Map.of("uri", "trips://secret-4412"));
            wire.request("resources/read", Map.of("uri", "db://customers/lovelace"));
            wire.request("prompts/get", Map.of("name", "plan_trip", "arguments", Map.of("destination", "Lisbon")));
            wire.request("prompts/get", Map.of("name", "translate"));
            wire.request("prompts/get", Map.of("name", "broken"));
            wire.request("resources/list", Map.of());
        }

        List<ToolCallEvent> recorded = delivered();
        assertEquals(List.of(
            List.of("resource", "config://app", "-"),
            List.of("resource", "trips://{id}", "-"),
            List.of("resource", "db://", "unknown_resource"),
            List.of("prompt", "plan_trip", "-"),
            List.of("prompt", "translate", "unknown_prompt"),
            List.of("prompt", "broken", "exception")),
            recorded.stream().map(e -> List.of(e.kind(), e.toolName(), e.errorSource() == null ? "-" : e.errorSource()))
                .toList());
        assertEquals(Map.of("id", "string"), recorded.get(1).parameters());
        assertEquals(Map.of("destination", "string"), recorded.get(3).parameters());
        assertEquals("BookingException", recorded.get(5).errorType());
        for (ToolCallEvent event : recorded) {
            assertEquals("cursor", event.clientType());
            assertFalse(event.toString().contains("lovelace") || event.toString().contains("Lisbon"), event.toString());
        }
    }

    @Test
    void keepsNothingOfAnAddressPastItsScheme() {
        assertEquals("db://", Primitives.schemeOf("db://customers/4412"));
        assertEquals("file://", Primitives.schemeOf("file:///home/ada/cv.pdf"));
        assertEquals("unknown://", Primitives.schemeOf("customers/4412"));
        assertEquals("unknown://", Primitives.schemeOf("4412:secret"));
    }

    @FunctionalInterface
    private interface BiFunctionRead {
        McpSchema.ReadResourceResult apply(io.modelcontextprotocol.server.McpSyncServerExchange exchange,
                                           McpSchema.ReadResourceRequest request);
    }
}
