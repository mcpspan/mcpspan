package com.mcpspan.internal;

import java.util.Map;

/**
 * One tool call, in the shape the ingest API takes. Parameter values are never part of it. Internal: not part of
 * the package's API.
 */
public record ToolCallEvent(
    String id,
    String kind,
    String toolName,
    double durationMs,
    boolean success,
    String errorSource,
    String errorType,
    String errorMessage,
    String clientType,
    String clientName,
    String clientVersion,
    String serverVersion,
    Long responseBytes,
    String definitionHash,
    String timestamp,
    String sdkVersion,
    String sessionId,
    Map<String, String> parameters) {

    /** How a failed call announced itself, as the contract names it. */
    public static final String RESULT = "result";
    /** A tool threw. */
    public static final String EXCEPTION = "exception";
    /** The server refused the arguments before the tool ran. */
    public static final String ARGUMENTS = "arguments";
    /** The server has no tool by that name. */
    public static final String UNKNOWN_TOOL = "unknown_tool";
    /** The server has nothing at the address read. */
    public static final String UNKNOWN_RESOURCE = "unknown_resource";
    /** The server has no prompt by that name. */
    public static final String UNKNOWN_PROMPT = "unknown_prompt";

    /** A resource read (contract, 3.5); a tool call has no kind. */
    public static final String RESOURCE = "resource";
    /** A prompt got (contract, 3.5). */
    public static final String PROMPT = "prompt";

    /** The event as JSON, leaving absent fields out rather than sending them as null. */
    public void writeTo(StringBuilder json) {
        json.append('{');
        Json.field(json, "id", id, true);
        Json.field(json, "kind", kind, false);
        Json.field(json, "toolName", toolName, false);
        json.append(",\"durationMs\":").append(Double.isFinite(durationMs) ? durationMs : 0);
        json.append(",\"success\":").append(success);
        Json.field(json, "errorSource", errorSource, false);
        Json.field(json, "errorType", errorType, false);
        Json.field(json, "errorMessage", errorMessage, false);
        Json.field(json, "clientType", clientType, false);
        Json.field(json, "clientName", clientName, false);
        Json.field(json, "clientVersion", clientVersion, false);
        Json.field(json, "serverVersion", serverVersion, false);
        Json.field(json, "definitionHash", definitionHash, false);
        if (responseBytes != null) {
            json.append(",\"responseBytes\":").append(responseBytes.longValue());
        }
        Json.field(json, "timestamp", timestamp, false);
        Json.field(json, "sdkVersion", sdkVersion, false);
        Json.field(json, "sessionId", sessionId, false);
        if (parameters != null) {
            json.append(",\"parameters\":{");
            boolean first = true;
            for (Map.Entry<String, String> entry : parameters.entrySet()) {
                Json.field(json, entry.getKey(), entry.getValue(), first);
                first = false;
            }
            json.append('}');
        }
        json.append('}');
    }
}
