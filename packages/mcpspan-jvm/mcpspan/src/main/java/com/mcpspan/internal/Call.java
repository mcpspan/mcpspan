package com.mcpspan.internal;

import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * One tool call, from the moment it starts to how it ended. Internal: not part of the package's API.
 */
public final class Call {

    private static final DateTimeFormatter TIMESTAMP =
        DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC);

    private final String kind;
    private final String toolName;
    private final Map<String, String> described;
    private final String clientName;
    private final String sessionId;
    private final Map<String, ?> arguments;
    private final long started = System.nanoTime();
    private final String timestamp = TIMESTAMP.format(Instant.now());
    private volatile String clientVersion;
    private volatile String serverVersion;
    private volatile boolean reached;
    private volatile boolean repeated;
    private volatile boolean recorded;

    /** A call starting now. */
    public Call(String toolName, String clientName, String sessionId, Map<String, ?> arguments) {
        this(null, toolName, clientName, sessionId, arguments, null);
    }

    /**
     * A call of a kind other than a tool's: a resource read or a prompt got (contract, 3.5). {@code described}
     * holds parameters already described by name and type, as a URI template's variables are.
     */
    public Call(String kind, String toolName, String clientName, String sessionId, Map<String, ?> arguments,
                Map<String, String> described) {
        this.kind = kind;
        this.described = described;
        this.toolName = toolName == null ? "" : toolName;
        this.clientName = clientName;
        this.sessionId = sessionId;
        this.arguments = arguments;
    }

    /**
     * The versions the client and the server give themselves (contract, 3.6). A version set for the SDK wins
     * over the server's own when the call is recorded.
     */
    public Call versions(String clientVersion, String serverVersion) {
        this.clientVersion = clientVersion;
        this.serverVersion = serverVersion;
        return this;
    }

    /**
     * Compares the call's arguments with the previous call's to the same tool in its session (contract, 3.9), once,
     * as the request arrives; {@code params}, the request's, say whether it continues an earlier call instead.
     */
    public Call compareArguments(Object params) {
        if (sessionId != null && kind == null && !Repeats.continuesEarlierCall(params)) {
            this.repeated = Repeats.note(sessionId, toolName, arguments);
        }
        return this;
    }

    /** Marks the call as having got as far as the tool's own code. */
    public void reached() {
        this.reached = true;
    }

    /** Whether the call was seen to reach the tool's own code. */
    public boolean wasReached() {
        return reached;
    }

    /** The tool called. */
    public String toolName() {
        return toolName;
    }

    /** Records a success. */
    public void succeeded() {
        succeeded(null);
    }

    /** Records a success, with the size of its answer in bytes (contract, 3.7), or null when unmeasured. */
    public void succeeded(Long responseBytes) {
        record(true, null, null, null, responseBytes);
    }

    /** Records a result the tool marked as an error, with its text blocks. */
    public void failedWithResult(List<String> texts) {
        failedWithResult(texts, null);
    }

    /** Records a result the tool marked as an error, with its text blocks and the size of the result. */
    public void failedWithResult(List<String> texts, Long responseBytes) {
        record(false, ToolCallEvent.RESULT, null, Text.resultMessage(texts), responseBytes);
    }

    /** Records an exception the tool threw. */
    public void failedWithException(Throwable error) {
        record(false, ToolCallEvent.EXCEPTION, Text.errorType(error), Text.errorMessage(error), null);
    }

    /** Records a call refused before any tool ran: no message, since it can name what was sent. */
    public void refused(String source) {
        record(false, source, null, null, null);
    }

    private void record(boolean success, String source, String type, String message, Long responseBytes) {
        if (recorded) {
            return;
        }
        recorded = true;
        try {
            if (!Collector.collecting()) {
                return;
            }
            Collector.record(new ToolCallEvent(
                UUID.randomUUID().toString(),
                kind,
                Text.truncate(toolName, Text.MAX_NAME),
                (System.nanoTime() - started) / 1e6,
                success,
                source,
                type,
                message,
                Clients.detect(clientName),
                Clients.name(clientName),
                Text.version(clientVersion),
                Text.version(Collector.serverVersion() != null ? Collector.serverVersion() : serverVersion),
                responseBytes,
                // A tool the server has, refused arguments included: often the schema is why.
                kind == null && !ToolCallEvent.UNKNOWN_TOOL.equals(source) ? Definitions.of(toolName) : null,
                kind == null && repeated ? Boolean.TRUE : null,
                timestamp,
                Version.CURRENT,
                sessionId,
                !Collector.captureParameterNames() ? null
                    : described != null ? described : Parameters.describe(arguments)));
        }
        catch (RuntimeException ignored) {
            // Recording a call must never disturb the call itself.
        }
    }
}
