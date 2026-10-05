# frozen_string_literal: true

require "json"

module McpSpan
  # One call of a tool, a resource or a prompt, in the shape the ingest API takes. Parameter values are never in it.
  Event = Struct.new(
    :id, :kind, :tool_name, :duration_ms, :success, :error_source, :error_type, :error_message,
    :client_type, :client_name, :client_version, :server_version, :response_bytes, :definition_hash, :repeated,
    :timestamp, :session_id, :parameters,
    keyword_init: true,
  ) do
    # The event as the API takes it, leaving absent fields out rather than sending them as null.
    def to_h
      {
        id: id,
        kind: kind,
        toolName: tool_name,
        durationMs: duration_ms,
        success: success,
        errorSource: error_source,
        errorType: error_type,
        errorMessage: error_message,
        clientType: client_type,
        clientName: client_name,
        clientVersion: client_version,
        serverVersion: server_version,
        responseBytes: response_bytes,
        definitionHash: definition_hash,
        repeated: repeated,
        timestamp: timestamp,
        sdkVersion: VERSION,
        sessionId: session_id,
        parameters: parameters,
      }.compact
    end

    # The body of one batch.
    def self.batch(events)
      JSON.generate({ events: events.map(&:to_h) })
    end
  end

  # How a failed call announced itself, as the contract names it.
  module Source
    RESULT = "result"
    EXCEPTION = "exception"
    ARGUMENTS = "arguments"
    UNKNOWN_TOOL = "unknown_tool"
    UNKNOWN_RESOURCE = "unknown_resource"
    UNKNOWN_PROMPT = "unknown_prompt"
  end
end
