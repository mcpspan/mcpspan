package adapter;

import com.mcpspan.McpSpanOptions;
import com.mcpspan.javasdk.McpSpanJavaSdk;
import io.modelcontextprotocol.json.McpJsonDefaults;
import io.modelcontextprotocol.server.McpServer;
import io.modelcontextprotocol.server.McpServerFeatures.SyncPromptSpecification;
import io.modelcontextprotocol.server.McpServerFeatures.SyncResourceSpecification;
import io.modelcontextprotocol.server.McpServerFeatures.SyncResourceTemplateSpecification;
import io.modelcontextprotocol.server.McpServerFeatures.SyncToolSpecification;
import io.modelcontextprotocol.server.transport.StdioServerTransportProvider;
import io.modelcontextprotocol.spec.McpSchema;
import io.modelcontextprotocol.spec.McpServerTransportProvider;
import io.modelcontextprotocol.spec.McpSchema.CallToolResult;
import io.modelcontextprotocol.spec.McpSchema.TextContent;
import io.modelcontextprotocol.spec.McpSchema.Tool;
import java.time.Duration;
import java.util.List;
import java.util.Map;

/** An MCP server over stdio with the conformance suite's tools, instrumented with the JVM SDK. */
public final class Main {

    static McpSchema.ReadResourceResult contents(String uri) {
        return McpSchema.ReadResourceResult.builder(List.of(McpSchema.TextResourceContents.builder(uri, "ok").build())).build();
    }

    static final class ConformanceError extends RuntimeException {
        private static final long serialVersionUID = 1L;

        ConformanceError(String message) {
            super(message);
        }
    }

    private static final Map<String, Object> NO_INPUT = Map.of("type", "object");

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

    public static void main(String[] args) throws Exception {
        long flushMs = Long.parseLong(System.getenv().getOrDefault("CONFORMANCE_FLUSH_MS", "200"));

        // Instrumented through its transport, as a stdio server should be: the transport starts reading as the
        // server is built, and a session instrumented as it is created misses none of the first calls. Every
        // tool is given at build time, as a Java server has them; instrumentation measures them all, as it must
        // tools registered before it ran.
        McpServerTransportProvider transport = McpSpanJavaSdk.instrument(
            new StdioServerTransportProvider(McpJsonDefaults.getMapper()),
            McpSpanOptions.builder()
                .endpoint(System.getenv("MCPSPAN_ENDPOINT"))
                .flushInterval(Duration.ofMillis(flushMs))
                .captureParameterNames("1".equals(System.getenv("CONFORMANCE_CAPTURE_PARAMETERS")))
                .captureErrorMessages(!"0".equals(System.getenv("CONFORMANCE_CAPTURE_ERROR_MESSAGES")))
                .build());

        McpServer.sync(transport)
            .serverInfo("conformance", "1.0.0")
            .capabilities(McpSchema.ServerCapabilities.builder().tools(true).resources(false, false).prompts(false).build())
            // Allows the long-named tool, whose name the SDK would otherwise refuse past 128 characters.
            .strictToolNameValidation(false)
            .tools(
                tool("early", NO_INPUT, () -> text("ok", false)),
                tool("ok", NO_INPUT, () -> text("ok", false)),
                tool("large", NO_INPUT, () -> text("x".repeat(100_000), false)),
                tool("reported_error", NO_INPUT, () -> text("No flights found", true)),
                tool("throws", NO_INPUT, () -> {
                    throw new ConformanceError("boom");
                }),
                tool("typed", Map.of(
                    "type", "object",
                    "properties", Map.of("destination", Map.of("type", "string"), "passengers", Map.of("type", "number")),
                    "required", List.of("destination", "passengers")), () -> text("ok", false)),
                McpSpanJavaSdk.exclude(tool("excluded", Map.of(
                    "type", "object",
                    "properties", Map.of("depth", Map.of("type", "number")),
                    "required", List.of("depth")), () -> text("ok", false))),
                tool("long_" + "x".repeat(295), NO_INPUT, () -> text("ok", false)))
            // Resources and prompts (contract, 3.5): one resource at a fixed address, one read through a template,
            // one that throws; a prompt with a required argument, and one that throws.
            .resources(
                new SyncResourceSpecification(McpSchema.Resource.builder("config://app", "config").build(),
                    (exchange, request) -> contents(request.uri())),
                new SyncResourceSpecification(McpSchema.Resource.builder("broken://status", "broken").build(),
                    (exchange, request) -> {
                        throw new ConformanceError("boom");
                    }))
            .resourceTemplates(new SyncResourceTemplateSpecification(
                McpSchema.ResourceTemplate.builder("trips://{id}", "trip").build(),
                (exchange, request) -> contents(request.uri())))
            .prompts(
                new SyncPromptSpecification(
                    McpSchema.Prompt.builder("plan_trip")
                        .arguments(List.of(McpSchema.PromptArgument.builder("destination").required(true).build()))
                        .build(),
                    (exchange, request) -> McpSchema.GetPromptResult.builder(List.of(McpSchema.PromptMessage.builder(
                        McpSchema.Role.USER,
                        TextContent.builder("Plan a trip to " + request.arguments().get("destination")).build()).build()))
                        .build()),
                new SyncPromptSpecification(McpSchema.Prompt.builder("broken_prompt").build(), (exchange, request) -> {
                    throw new ConformanceError("boom");
                }))
            .build();

        // The stdio transport reads on threads of its own. The process lives until the client leaves, closing
        // standard input, and what is queued is delivered as the JVM shuts down.
        Thread.currentThread().join();
    }
}
