package com.mcpspan.javasdk;

import com.mcpspan.internal.Call;
import com.mcpspan.internal.Collector;
import com.mcpspan.internal.Sessions;
import com.mcpspan.internal.ToolCallEvent;
import io.modelcontextprotocol.server.McpAsyncServer;
import io.modelcontextprotocol.server.McpRequestHandler;
import io.modelcontextprotocol.server.McpServerFeatures.AsyncResourceTemplateSpecification;
import io.modelcontextprotocol.spec.McpSchema;
import io.modelcontextprotocol.util.DefaultMcpUriTemplateManagerFactory;
import io.modelcontextprotocol.util.McpUriTemplateManager;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Resource reads and prompt gets (contract, 3.5), from the request handlers the server gives each session, where
 * {@code tools/call} is watched too.
 *
 * <p>The call is named before it runs, from the server's own records, which the SDK keeps privately beside its
 * tools: a resource at a fixed address by that address, one read through a template by the template (never the
 * address the client sent), an address the server has nothing for by its scheme alone, a prompt by its name.
 * Templates are matched as the SDK matches them, with its own template manager. The SDK does not check a prompt's
 * required arguments; its handler gets what was sent and decides, so there is no refusal of arguments to record.
 */
final class Primitives {

    private static final Pattern SCHEME = Pattern.compile("^([a-zA-Z][a-zA-Z0-9+.-]*):");

    private Primitives() {
    }

    static McpRequestHandler<Object> handler(McpAsyncServer server, String method, McpRequestHandler<Object> original) {
        boolean resource = McpSchema.METHOD_RESOURCES_READ.equals(method);
        return (exchange, params) -> {
            if (!Collector.collecting()) {
                return original.handle(exchange, params);
            }

            Call call;
            boolean exists;
            try {
                Instrumentation.Client client = Instrumentation.clientOf(
                    Instrumentation.metaOf(params), exchange != null ? exchange.getClientInfo() : null);
                String serverVersion = Instrumentation.serverVersionOf(server);
                String session = exchange != null && exchange.sessionId() != null
                    ? Sessions.of(server, false, exchange.sessionId())
                    : null;

                if (resource) {
                    String uri = params instanceof Map<?, ?> map && map.get("uri") instanceof String u ? u : "";
                    Resolved resolved = resolve(server, uri);
                    exists = resolved.exists;
                    call = new Call(ToolCallEvent.RESOURCE, resolved.name, client.name(), session, null, resolved.variables)
                        .versions(client.version(), serverVersion);
                }
                else {
                    Map<?, ?> map = params instanceof Map<?, ?> m ? m : Map.of();
                    String name = map.get("name") instanceof String n ? n : "";
                    exists = Instrumentation.read(server, "prompts") instanceof Map<?, ?> prompts
                        && prompts.containsKey(name);
                    @SuppressWarnings("unchecked")
                    Map<String, ?> arguments = map.get("arguments") instanceof Map<?, ?> a ? (Map<String, ?>) a : null;
                    call = new Call(ToolCallEvent.PROMPT, name, client.name(), session, arguments, null)
                        .versions(client.version(), serverVersion);
                }
            }
            catch (RuntimeException e) {
                return original.handle(exchange, params);
            }

            String unknown = resource ? ToolCallEvent.UNKNOWN_RESOURCE : ToolCallEvent.UNKNOWN_PROMPT;
            return original.handle(exchange, params)
                .doOnSuccess(result -> call.succeeded(Sizes.of(result)))
                .doOnError(error -> {
                    if (exists) {
                        call.failedWithException(error);
                    }
                    else {
                        call.refused(unknown);
                    }
                });
        };
    }

    private record Resolved(String name, boolean exists, Map<String, String> variables) {
    }

    private static Resolved resolve(McpAsyncServer server, String uri) {
        if (Instrumentation.read(server, "resources") instanceof Map<?, ?> fixed && fixed.containsKey(uri)) {
            return new Resolved(uri, true, null);
        }
        if (Instrumentation.read(server, "resourceTemplates") instanceof Map<?, ?> templates) {
            var factory = new DefaultMcpUriTemplateManagerFactory();
            for (Object value : templates.values()) {
                if (value instanceof AsyncResourceTemplateSpecification spec && spec.resourceTemplate() != null) {
                    String template = spec.resourceTemplate().uriTemplate();
                    McpUriTemplateManager manager = factory.create(template);
                    if (manager.matches(uri)) {
                        Map<String, String> variables = new LinkedHashMap<>();
                        for (String name : manager.getVariableNames()) {
                            variables.put(name, "string");
                        }
                        return new Resolved(template, true, variables.isEmpty() ? null : variables);
                    }
                }
            }
        }
        return new Resolved(schemeOf(uri), false, null);
    }

    /** The scheme of an address, which is all of an unknown one that may be kept: {@code db://}. */
    static String schemeOf(String uri) {
        Matcher match = SCHEME.matcher(uri == null ? "" : uri);
        return match.find() ? match.group(1) + "://" : "unknown://";
    }
}
