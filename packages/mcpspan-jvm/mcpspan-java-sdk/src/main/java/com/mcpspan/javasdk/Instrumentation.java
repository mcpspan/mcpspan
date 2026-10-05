package com.mcpspan.javasdk;

import com.mcpspan.internal.Call;
import com.mcpspan.internal.Collector;
import com.mcpspan.internal.Exclusions;
import com.mcpspan.internal.Sessions;
import com.mcpspan.internal.ToolCallEvent;
import io.modelcontextprotocol.server.McpAsyncServer;
import io.modelcontextprotocol.server.McpAsyncServerExchange;
import io.modelcontextprotocol.server.McpRequestHandler;
import io.modelcontextprotocol.server.McpServerFeatures.AsyncToolSpecification;
import io.modelcontextprotocol.server.McpServerFeatures.SyncToolSpecification;
import io.modelcontextprotocol.server.McpSyncServerExchange;
import io.modelcontextprotocol.spec.McpError;
import io.modelcontextprotocol.spec.McpSchema;
import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Deque;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.BiFunction;
import reactor.core.publisher.Mono;

/**
 * How a server built on the MCP Java SDK is instrumented.
 *
 * <p>The SDK offers no middleware, filter or hook for tool calls, so this reaches into two private places, as the
 * TypeScript and Python SDKs do in theirs: the server's list of tools, whose handlers are wrapped where they sit,
 * and the {@code tools/call} request handler the server gives each session, which sees the calls the server
 * refuses before any tool runs. Wherever the SDK does not look as expected, this finds nothing and leaves the
 * server exactly as it was, which is the safe way for it to fail.
 */
final class Instrumentation {

    /** The request's {@link Call}, in the Reactor context from the request handler to the tool it reaches. */
    static final String CALL_KEY = "mcpspan.call";

    /** Where a request on the 2026-07-28 protocol names its client. */
    static final String CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo";

    private static final Set<Object> WRAPPED_HANDLERS = Collections.newSetFromMap(Collections.synchronizedMap(new IdentityHashMap<>()));

    /**
     * Requests an instrumented server is watching, by identity. The SDK hands a synchronous tool the very request
     * object its asynchronous wrapper received, so a tool tracked by hand can tell it is already being counted.
     */
    private static final Set<Object> WATCHED = Collections.newSetFromMap(Collections.synchronizedMap(new IdentityHashMap<>()));

    private Instrumentation() {
    }

    static void instrument(McpAsyncServer server) {
        instrument(server, handlersOf(server));
    }

    /** Instruments a server whose request handlers are already known, as a session being created has them. */
    static void instrument(McpAsyncServer server, Map<String, McpRequestHandler<?>> handlers) {
        List<AsyncToolSpecification> tools = toolsOf(server);
        if (tools != null) {
            wrapAll(tools);
        }

        if (handlers != null && tools != null) {
            McpRequestHandler<?> original = handlers.get(McpSchema.METHOD_TOOLS_CALL);
            if (original != null && !WRAPPED_HANDLERS.contains(original)) {
                McpRequestHandler<McpSchema.CallToolResult> wrapped = callHandler(server, tools, cast(original));
                WRAPPED_HANDLERS.add(wrapped);
                // Replacing the value of a key already there, which never restructures the map, so a session
                // reading it at the same moment sees one handler or the other.
                handlers.put(McpSchema.METHOD_TOOLS_CALL, wrapped);
            }
        }

        if (handlers != null) {
            McpRequestHandler<?> listing = handlers.get(McpSchema.METHOD_TOOLS_LIST);
            if (listing != null && !WRAPPED_HANDLERS.contains(listing)) {
                McpRequestHandler<Object> wrapped = Listings.handler(castAny(listing));
                WRAPPED_HANDLERS.add(wrapped);
                handlers.put(McpSchema.METHOD_TOOLS_LIST, wrapped);
            }

            for (String method : List.of(McpSchema.METHOD_RESOURCES_READ, McpSchema.METHOD_PROMPT_GET)) {
                McpRequestHandler<?> original = handlers.get(method);
                if (original != null && !WRAPPED_HANDLERS.contains(original)) {
                    McpRequestHandler<Object> wrapped = Primitives.handler(server, method, castAny(original));
                    WRAPPED_HANDLERS.add(wrapped);
                    handlers.put(method, wrapped);
                }
            }
        }
    }

    // ---------------------------------------------------------------- tools

    /** Wraps every tool the list holds that is not wrapped yet, in place, without telling any client. */
    private static void wrapAll(List<AsyncToolSpecification> tools) {
        for (int i = 0; i < tools.size(); i++) {
            AsyncToolSpecification tool = tools.get(i);
            AsyncToolSpecification wrapped = track(tool);
            if (wrapped != tool) {
                tools.set(i, wrapped);
            }
        }
    }

    static AsyncToolSpecification track(AsyncToolSpecification tool) {
        if (tool == null || tool.callHandler() instanceof Tracked || excluded(tool.tool())) {
            return tool;
        }
        return new AsyncToolSpecification(tool.tool(), new Tracked(tool.callHandler()));
    }

    static SyncToolSpecification track(SyncToolSpecification tool) {
        if (tool == null || tool.callHandler() instanceof TrackedSync || excluded(tool.tool())) {
            return tool;
        }
        return new SyncToolSpecification(tool.tool(), new TrackedSync(tool.callHandler()));
    }

    private static boolean excluded(McpSchema.Tool tool) {
        return tool == null || Exclusions.excluded(tool.name());
    }

    /**
     * A tool's handler, which marks the call as reached when an instrumented server is watching it, and records
     * the call itself when nothing is.
     */
    private record Tracked(
        BiFunction<McpAsyncServerExchange, McpSchema.CallToolRequest, Mono<McpSchema.CallToolResult>> original)
        implements BiFunction<McpAsyncServerExchange, McpSchema.CallToolRequest, Mono<McpSchema.CallToolResult>> {

        @Override
        public Mono<McpSchema.CallToolResult> apply(McpAsyncServerExchange exchange, McpSchema.CallToolRequest request) {
            return Mono.deferContextual(context -> {
                Object watching = context.getOrDefault(CALL_KEY, null);
                if (watching instanceof Call call) {
                    call.reached();
                    WATCHED.add(request);
                    return original.apply(exchange, request).doFinally(signal -> WATCHED.remove(request));
                }
                if (!Collector.collecting()) {
                    return original.apply(exchange, request);
                }
                Call call = begin(exchange, request, null, Tracked.class);
                call.reached();
                WATCHED.add(request);
                return settle(original.apply(exchange, request), call, true)
                    .doFinally(signal -> WATCHED.remove(request));
            });
        }
    }

    /** The same, for a synchronous tool, which knows nothing of Reactor. */
    private record TrackedSync(
        BiFunction<McpSyncServerExchange, McpSchema.CallToolRequest, McpSchema.CallToolResult> original)
        implements BiFunction<McpSyncServerExchange, McpSchema.CallToolRequest, McpSchema.CallToolResult> {

        @Override
        public McpSchema.CallToolResult apply(McpSyncServerExchange exchange, McpSchema.CallToolRequest request) {
            // On an instrumented server the SDK's asynchronous form of this tool is wrapped as well, and that
            // wrapper counts the call; this one counts only when nothing else is watching.
            if (!Collector.collecting() || WATCHED.contains(request)) {
                return original.apply(exchange, request);
            }
            Call call = begin(exchange, request);
            call.reached();
            McpSchema.CallToolResult result;
            try {
                result = original.apply(exchange, request);
            }
            catch (RuntimeException | Error e) {
                call.failedWithException(e);
                throw e;
            }
            outcome(call, result);
            return result;
        }
    }

    // ------------------------------------------------------ request handler

    private static McpRequestHandler<McpSchema.CallToolResult> callHandler(
        McpAsyncServer server, List<AsyncToolSpecification> tools, McpRequestHandler<McpSchema.CallToolResult> original) {

        return (exchange, params) -> {
            if (!Collector.collecting()) {
                return original.handle(exchange, params);
            }

            Call call;
            String name;
            try {
                name = nameOf(params);
                if (name == null || Exclusions.excluded(name)) {
                    return original.handle(exchange, params);
                }
                // A tool added since instrument() ran is wrapped the first time it is called.
                wrapAll(tools);
                call = begin(exchange, null, params, server);
            }
            catch (RuntimeException e) {
                return original.handle(exchange, params);
            }

            boolean known = tools.stream().anyMatch(t -> t.tool() != null && name.equals(t.tool().name()));
            return settle(original.handle(exchange, params), call, known)
                .contextWrite(context -> context.put(CALL_KEY, call));
        };
    }

    /** Records how a call ended, on its way past, changing nothing about it. */
    private static Mono<McpSchema.CallToolResult> settle(Mono<McpSchema.CallToolResult> answer, Call call, boolean known) {
        return answer
            .doOnSuccess(result -> {
                if (call.wasReached()) {
                    outcome(call, result);
                }
                else if (result != null && Boolean.TRUE.equals(result.isError())) {
                    // The server answered without running the tool: its input validation refused the arguments.
                    call.refused(ToolCallEvent.ARGUMENTS);
                }
                else {
                    outcome(call, result);
                }
            })
            .doOnError(error -> {
                if (!known && !call.wasReached() && error instanceof McpError mcpError
                    && mcpError.getJsonRpcError() != null
                    && mcpError.getJsonRpcError().code() == McpSchema.ErrorCodes.INVALID_PARAMS) {
                    call.refused(ToolCallEvent.UNKNOWN_TOOL);
                }
                else {
                    call.failedWithException(error);
                }
            });
    }

    private static void outcome(Call call, McpSchema.CallToolResult result) {
        if (result != null && Boolean.TRUE.equals(result.isError())) {
            List<String> texts = new ArrayList<>();
            if (result.content() != null) {
                for (McpSchema.Content content : result.content()) {
                    if (content instanceof McpSchema.TextContent text && text.text() != null) {
                        texts.add(text.text());
                    }
                }
            }
            call.failedWithResult(texts, Sizes.of(result));
        }
        else {
            call.succeeded(Sizes.of(result));
        }
    }

    /**
     * What is known about a call as it starts: from the request params, or the request the tool was handed.
     * {@code connection} keys the session: the server, or for a tool tracked alone its wrapper.
     */
    private static Call begin(McpAsyncServerExchange exchange, McpSchema.CallToolRequest request, Object params,
                              Object connection) {
        String name = request != null ? request.name() : nameOf(params);
        Map<String, Object> arguments = request != null ? request.arguments() : argumentsOf(params);
        Map<String, Object> meta = request != null ? request.meta() : metaOf(params);

        Client client = clientOf(meta, exchange != null ? exchange.getClientInfo() : null);

        // One identifier per session of this server: stdio has one, stateful HTTP one per client.
        String session = exchange != null && exchange.sessionId() != null
            ? Sessions.of(connection, false, exchange.sessionId())
            : null;

        return new Call(name, client.name(), session, arguments)
            .versions(client.version(), connection instanceof McpAsyncServer server ? serverVersionOf(server) : null)
            .compareArguments(params);
    }

    /** The same, for a synchronous tool tracked by hand, from the exchange the SDK handed it. */
    private static Call begin(McpSyncServerExchange exchange, McpSchema.CallToolRequest request) {
        Client client = clientOf(request.meta(), exchange != null ? exchange.getClientInfo() : null);
        String session = exchange != null && exchange.sessionId() != null
            ? Sessions.of(TrackedSync.class, false, exchange.sessionId())
            : null;
        return new Call(request.name(), client.name(), session, request.arguments()).versions(client.version(), null)
            .compareArguments(null);
    }

    private static String nameOf(Object params) {
        return params instanceof Map<?, ?> map && map.get("name") instanceof String name ? name : null;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> argumentsOf(Object params) {
        return params instanceof Map<?, ?> map && map.get("arguments") instanceof Map<?, ?> arguments
            ? (Map<String, Object>) arguments : null;
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> metaOf(Object params) {
        return params instanceof Map<?, ?> map && map.get("_meta") instanceof Map<?, ?> meta
            ? (Map<String, Object>) meta : null;
    }

    /** The client that sent a request, as it names itself. Either part may be null. */
    record Client(String name, String version) {
    }

    /** From the request's _meta first, on the 2026-07-28 protocol; else this session's handshake. */
    static Client clientOf(Map<String, Object> meta, McpSchema.Implementation handshake) {
        if (meta != null && meta.get(CLIENT_INFO_META_KEY) instanceof Map<?, ?> info
            && info.get("name") instanceof String name) {
            return new Client(name, info.get("version") instanceof String version ? version : null);
        }
        return handshake != null ? new Client(handshake.name(), handshake.version()) : new Client(null, null);
    }

    /** The version the server gives itself, the {@code serverInfo} it was built with. Null when it has none. */
    static String serverVersionOf(McpAsyncServer server) {
        try {
            McpSchema.Implementation info = server.getServerInfo();
            return info != null ? info.version() : null;
        }
        catch (RuntimeException e) {
            return null;
        }
    }

    // ------------------------------------------------------------- finding

    /**
     * The server a session belongs to, from the {@code tools/call} handler it was given, which the server built
     * around itself. Null when the session has no tools, or looks unfamiliar.
     */
    static McpAsyncServer serverOf(Object session) {
        Object handlers = handlersOfSession(session);
        if (!(handlers instanceof Map<?, ?> map)) {
            return null;
        }
        for (String method : MEASURED) {
            Object handler = map.get(method);
            if (handler == null) {
                continue;
            }
            for (Field field : handler.getClass().getDeclaredFields()) {
                if (read(handler, field) instanceof McpAsyncServer server) {
                    return server;
                }
            }
        }
        return null;
    }

    @SuppressWarnings("unchecked")
    private static List<AsyncToolSpecification> toolsOf(McpAsyncServer server) {
        Object tools = read(server, "tools");
        return tools instanceof List<?> list ? (List<AsyncToolSpecification>) list : null;
    }

    /**
     * The request handlers the server hands its sessions. They are built in its constructor and passed to its
     * transport's session factory, or to the one session a stdio transport makes at once, and kept nowhere of the
     * server's own; so they are looked for from the transport, a few references deep, among the SDK's own objects.
     */
    @SuppressWarnings("unchecked")
    private static Map<String, McpRequestHandler<?>> handlersOf(McpAsyncServer server) {
        Object transport = read(server, "mcpTransportProvider");
        Deque<Object[]> pending = new ArrayDeque<>();
        Set<Object> seen = Collections.newSetFromMap(new IdentityHashMap<>());
        pending.add(new Object[] {transport, 0});

        while (!pending.isEmpty()) {
            Object[] next = pending.poll();
            Object object = next[0];
            int depth = (int) next[1];
            if (object == null || !seen.add(object)) {
                continue;
            }
            if (object instanceof Map<?, ?> map) {
                if (isHandlerMap(map)) {
                    return (Map<String, McpRequestHandler<?>>) map;
                }
                continue;
            }
            if (depth >= 3 || !isSdkOwned(object.getClass())) {
                continue;
            }
            for (Class<?> type = object.getClass(); type != null && type != Object.class; type = type.getSuperclass()) {
                for (Field field : type.getDeclaredFields()) {
                    if (Modifier.isStatic(field.getModifiers()) || field.getType().isPrimitive()) {
                        continue;
                    }
                    Object value = read(object, field);
                    if (value != null) {
                        pending.add(new Object[] {value, depth + 1});
                    }
                }
            }
        }
        return null;
    }

    /** The request handlers a session was given, or null. */
    @SuppressWarnings("unchecked")
    static Map<String, McpRequestHandler<?>> handlersOfSession(Object session) {
        return read(session, "requestHandlers") instanceof Map<?, ?> map && isHandlerMap(map)
            ? (Map<String, McpRequestHandler<?>>) map : null;
    }

    /** Methods whose handler says a map is the server's request handlers, whichever the server offers. */
    private static final List<String> MEASURED = List.of(
        McpSchema.METHOD_TOOLS_CALL, McpSchema.METHOD_RESOURCES_READ, McpSchema.METHOD_PROMPT_GET);

    private static boolean isHandlerMap(Map<?, ?> map) {
        for (String method : MEASURED) {
            if (map.get(method) instanceof McpRequestHandler<?>) {
                return true;
            }
        }
        return false;
    }

    /**
     * The SDK's own classes, the lambdas it passes around, and the transport wrapped here, as opposed to anything
     * of the JDK's.
     */
    private static boolean isSdkOwned(Class<?> type) {
        String name = type.getName();
        return name.startsWith("io.modelcontextprotocol.") || name.contains("$$Lambda")
            || type == InstrumentedTransport.class;
    }

    static Object read(Object target, String fieldName) {
        for (Class<?> type = target.getClass(); type != null; type = type.getSuperclass()) {
            try {
                return read(target, type.getDeclaredField(fieldName));
            }
            catch (NoSuchFieldException ignored) {
                // Declared further up, or not at all.
            }
        }
        return null;
    }

    private static Object read(Object target, Field field) {
        try {
            field.setAccessible(true);
            return field.get(target);
        }
        catch (RuntimeException | IllegalAccessException e) {
            return null;
        }
    }

    @SuppressWarnings("unchecked")
    private static McpRequestHandler<Object> castAny(McpRequestHandler<?> handler) {
        return (McpRequestHandler<Object>) handler;
    }

    @SuppressWarnings("unchecked")
    private static McpRequestHandler<McpSchema.CallToolResult> cast(McpRequestHandler<?> handler) {
        return (McpRequestHandler<McpSchema.CallToolResult>) handler;
    }
}
