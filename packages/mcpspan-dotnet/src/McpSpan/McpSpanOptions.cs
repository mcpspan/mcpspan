namespace McpSpan;

/// <summary>What the SDK needs to know. Every setting is optional.</summary>
public sealed record McpSpanOptions
{
    /// <summary>Identifies the server. Falls back to <c>MCPSPAN_API_KEY</c>; without either, nothing is collected.</summary>
    public string? ApiKey { get; init; }

    /// <summary>
    /// Base URL of your mcpspan installation. Falls back to <c>MCPSPAN_ENDPOINT</c>. There is no default: without
    /// either, nothing is collected, and the SDK says so once.
    /// </summary>
    public string? Endpoint { get; init; }

    /// <summary>Writes delivery diagnostics to standard error.</summary>
    public bool Debug { get; init; }

    /// <summary>Receives diagnostics instead of standard error. Implies <see cref="Debug"/>.</summary>
    public Action<string>? OnDiagnostic { get; init; }

    /// <summary>Delivers what is queued as the process exits. On by default.</summary>
    public bool FlushOnExit { get; init; } = true;

    /// <summary>How long a partly filled batch waits before being sent. Default five seconds.</summary>
    public TimeSpan? FlushInterval { get; init; }

    /// <summary>Events in one request. Reaching it sends at once. Default 100.</summary>
    public int? MaxBatchSize { get; init; }

    /// <summary>Events held while delivery is failing. Default 10,000.</summary>
    public int? MaxQueueSize { get; init; }

    /// <summary>
    /// Records which parameters a tool was called with, by name and JSON type. Off by default; values are
    /// never read.
    /// </summary>
    public bool CaptureParameterNames { get; init; }

    /// <summary>
    /// The version calls are recorded under: a release, a tag, a commit. Falls back to
    /// <c>MCPSPAN_SERVER_VERSION</c>, then to the version the server gives itself (<c>ServerInfo</c>), which is
    /// usually all that is needed. The dashboard marks where each one began.
    /// </summary>
    public string? ServerVersion { get; init; }
}
