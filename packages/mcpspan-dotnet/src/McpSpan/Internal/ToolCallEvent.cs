using System.Text.Json.Serialization;

namespace McpSpan.Internal;

/// <summary>One tool call, in the shape the ingest API takes. Parameter values are never part of it.</summary>
internal sealed record ToolCallEvent
{
    [JsonPropertyName("id")] public required string Id { get; init; }
    /// <summary>Null for a tool call; <c>resource</c> or <c>prompt</c> for the others (contract, 3.5).</summary>
    [JsonPropertyName("kind")] public string? Kind { get; init; }
    [JsonPropertyName("toolName")] public required string ToolName { get; init; }
    [JsonPropertyName("durationMs")] public required double DurationMs { get; init; }
    [JsonPropertyName("success")] public required bool Success { get; init; }
    [JsonPropertyName("errorSource")] public string? ErrorSource { get; init; }
    [JsonPropertyName("errorType")] public string? ErrorType { get; init; }
    [JsonPropertyName("errorMessage")] public string? ErrorMessage { get; init; }
    [JsonPropertyName("clientType")] public required string ClientType { get; init; }
    [JsonPropertyName("clientName")] public string? ClientName { get; init; }
    [JsonPropertyName("clientVersion")] public string? ClientVersion { get; init; }
    [JsonPropertyName("serverVersion")] public string? ServerVersion { get; init; }
    [JsonPropertyName("timestamp")] public required string Timestamp { get; init; }
    [JsonPropertyName("sdkVersion")] public required string SdkVersion { get; init; }
    [JsonPropertyName("sessionId")] public string? SessionId { get; init; }
    [JsonPropertyName("parameters")] public IReadOnlyDictionary<string, string>? Parameters { get; init; }
}

/// <summary>How a failed call announced itself, as the contract names it.</summary>
internal static class ErrorSources
{
    public const string Result = "result";
    public const string Exception = "exception";
    public const string Arguments = "arguments";
    public const string UnknownTool = "unknown_tool";
    public const string UnknownResource = "unknown_resource";
    public const string UnknownPrompt = "unknown_prompt";
}
