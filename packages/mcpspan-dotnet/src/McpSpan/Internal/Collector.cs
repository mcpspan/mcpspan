using System.Diagnostics;

namespace McpSpan.Internal;

/// <summary>The running configuration, shared by everything that records a call.</summary>
internal static class Collector
{
    /// <summary>
    /// Said when there is a key and nowhere to send: somebody meant to collect. There is no default endpoint, since
    /// mcpspan runs wherever its user runs it, and a default would send their data somewhere they did not choose.
    /// </summary>
    public const string NoEndpoint =
        "mcpspan: an API key is set but no endpoint, so nothing is collected. Set MCPSPAN_ENDPOINT (or the Endpoint " +
        "option) to your mcpspan installation, for example http://localhost:6271.";

    private static readonly object Gate = new();
    private static Reporter? _reporter;
    private static Settings? _active;
    private static bool _exitHookInstalled;
    private static bool _saidNoEndpoint;

    /// <summary>The effective settings, compared to recognise the same configuration arriving again.</summary>
    private sealed record Settings(
        string? ApiKey,
        string? Endpoint,
        bool Debug,
        Action<string>? OnDiagnostic,
        bool FlushOnExit,
        TimeSpan FlushInterval,
        int MaxBatchSize,
        int MaxQueueSize,
        bool CaptureParameterNames,
        string? ServerVersion);

    /// <summary>Whether a key is configured and calls are being recorded.</summary>
    public static bool Collecting => Volatile.Read(ref _reporter) is not null;

    public static bool CaptureParameterNames { get; private set; }

    /// <summary>The version every call is recorded under when one was set, whatever the server gives itself.</summary>
    public static string? ServerVersion { get; private set; }

    /// <summary>For tests: forgets that the missing endpoint was already mentioned.</summary>
    internal static void ForgetNoEndpointNotice()
    {
        lock (Gate)
        {
            _saidNoEndpoint = false;
        }
    }

    /// <summary>For tests: delivery goes here instead of over HTTP.</summary>
    internal static Func<IReadOnlyList<ToolCallEvent>, CancellationToken, Task>? SendOverride { get; set; }

    public static void Configure(McpSpanOptions options)
    {
        try
        {
            ConfigureCore(options);
        }
        catch (Exception exception)
        {
            if (options.Debug)
            {
                Console.Error.WriteLine($"mcpspan: could not configure ({exception.Message})");
            }
        }
    }

    private static void ConfigureCore(McpSpanOptions options)
    {
        var debug = options.Debug || options.OnDiagnostic is not null;
        var settings = new Settings(
            FirstNonEmpty(options.ApiKey, Environment.GetEnvironmentVariable("MCPSPAN_API_KEY")),
            FirstNonEmpty(options.Endpoint, Environment.GetEnvironmentVariable("MCPSPAN_ENDPOINT")),
            debug,
            options.OnDiagnostic,
            options.FlushOnExit,
            Positive(options.FlushInterval, Reporter.DefaultFlushInterval, "FlushInterval", debug),
            Math.Min(Positive(options.MaxBatchSize, Reporter.DefaultMaxBatchSize, "MaxBatchSize", debug), 1_000),
            Positive(options.MaxQueueSize, Reporter.DefaultMaxQueueSize, "MaxQueueSize", debug),
            options.CaptureParameterNames,
            FirstNonEmpty(options.ServerVersion, Environment.GetEnvironmentVariable("MCPSPAN_SERVER_VERSION")));

        Reporter? previous;
        lock (Gate)
        {
            if (_reporter is not null && _active == settings)
            {
                return;
            }

            previous = _reporter;
            _reporter = null;
            _active = null;
            CaptureParameterNames = false;
            ServerVersion = null;
        }

        previous?.StopAsync(Transport.Timeout + TimeSpan.FromSeconds(1)).GetAwaiter().GetResult();
        previous?.Dispose();

        // No key is a normal state, in development and CI, and not reported.
        if (settings.ApiKey is null)
        {
            return;
        }

        // Said unasked, as a refused key is: without it the data goes nowhere and nothing tells anyone. A test's
        // own delivery stands in for the endpoint.
        if (settings.Endpoint is null && SendOverride is null)
        {
            bool say;
            lock (Gate)
            {
                say = !_saidNoEndpoint;
                _saidNoEndpoint = true;
            }

            if (say)
            {
                if (settings.OnDiagnostic is not null)
                {
                    settings.OnDiagnostic(NoEndpoint);
                }
                else
                {
                    Console.Error.WriteLine(NoEndpoint);
                }
            }

            return;
        }

        var endpoint = settings.Endpoint ?? "http://sender.test";
        Transport? transport = SendOverride is null ? new Transport(endpoint, settings.ApiKey) : null;
        var reporter = new Reporter(
            endpoint,
            settings.FlushInterval,
            settings.MaxBatchSize,
            settings.MaxQueueSize,
            settings.Debug,
            settings.OnDiagnostic,
            SendOverride ?? transport!.SendAsync,
            transport);

        lock (Gate)
        {
            _reporter = reporter;
            _active = settings;
            CaptureParameterNames = settings.CaptureParameterNames;
            ServerVersion = settings.ServerVersion;

            if (settings.FlushOnExit && !_exitHookInstalled)
            {
                // Runs as the process ends on its own. It intercepts no signal and changes nothing about how or
                // when the process exits.
                AppDomain.CurrentDomain.ProcessExit += OnProcessExit;
                _exitHookInstalled = true;
            }
        }

        // In the background: startup does not wait for the network.
        reporter.Start();
    }

    public static async Task ShutdownAsync(CancellationToken cancellationToken)
    {
        try
        {
            Reporter? previous;
            lock (Gate)
            {
                previous = _reporter;
                _reporter = null;
                _active = null;
                CaptureParameterNames = false;
                ServerVersion = null;
            }

            if (previous is not null)
            {
                await previous.StopAsync(Transport.Timeout + TimeSpan.FromSeconds(1))
                    .WaitAsync(cancellationToken).ConfigureAwait(false);
                previous.Dispose();
            }
        }
        catch (Exception)
        {
            // Out of time or anything else: shutting down never fails.
        }
    }

    public static void Record(ToolCallEvent item) => Volatile.Read(ref _reporter)?.Record(item);

    private static void OnProcessExit(object? sender, EventArgs e)
    {
        bool flush;
        lock (Gate)
        {
            flush = _active?.FlushOnExit == true;
        }

        if (flush)
        {
            ShutdownAsync(CancellationToken.None).GetAwaiter().GetResult();
        }
    }

    private static string? FirstNonEmpty(params string?[] values) =>
        values.Select(value => value?.Trim()).FirstOrDefault(value => !string.IsNullOrEmpty(value));

    private static T Positive<T>(T? value, T fallback, string name, bool debug)
        where T : struct, IComparable<T>
    {
        if (value is not { } given)
        {
            return fallback;
        }

        if (given.CompareTo(default) > 0)
        {
            return given;
        }

        if (debug)
        {
            Console.Error.WriteLine($"mcpspan: ignoring {name}={given}, expected a positive value");
        }

        return fallback;
    }
}

/// <summary>What is known about a call as it starts, and turning how it ended into an event.</summary>
internal sealed class Call
{
    private readonly long _started = Stopwatch.GetTimestamp();

    public required string ToolName { get; init; }

    /// <summary>Null for a tool call; <c>resource</c> or <c>prompt</c> otherwise.</summary>
    public string? Kind { get; init; }

    /// <summary>Parameters already described by name and type, as a URI template's variables are.</summary>
    public IReadOnlyDictionary<string, string>? DescribedParameters { get; init; }

    public string? ClientName { get; init; }

    public string? ClientVersion { get; init; }

    /// <summary>The version the server gives itself; a version set for the SDK wins over it.</summary>
    public string? ServerVersion { get; init; }

    public string? SessionId { get; init; }

    public IDictionary<string, System.Text.Json.JsonElement>? Arguments { get; init; }

    public DateTimeOffset Timestamp { get; } = DateTimeOffset.UtcNow;

    /// <summary>Set when the call is seen to reach the tool's own code.</summary>
    public bool Reached { get; set; }

    /// <param name="response">The answer, to be measured (contract, 3.7); null when there was none.</param>
    public void Succeeded(object? response = null) => Record(success: true, null, null, null, response);

    public void Failed(string source, string? type = null, string? message = null, object? response = null) =>
        Record(success: false, source, type, message, response);

    /// <summary>The largest size an event carries; anything larger is sent as this (contract, 3.7).</summary>
    public const long MaxResponseBytes = int.MaxValue;

    /// <summary>
    /// Size of an answer in bytes of its compact JSON, encoded as the MCP SDK encodes it, or null when it
    /// cannot be. The JSON is counted and dropped; nothing of it is kept or sent.
    /// </summary>
    public static long? ResponseBytes(object? response)
    {
        if (response is null)
        {
            return null;
        }

        try
        {
            var size = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(
                response, response.GetType(), ModelContextProtocol.McpJsonUtilities.DefaultOptions).LongLength;
            return Math.Min(size, MaxResponseBytes);
        }
        catch (Exception)
        {
            return null;
        }
    }

    private void Record(bool success, string? source, string? type, string? message, object? response)
    {
        try
        {
            if (!Collector.Collecting)
            {
                return;
            }

            Collector.Record(new ToolCallEvent
            {
                Id = Guid.NewGuid().ToString(),
                Kind = Kind,
                ToolName = Text.Truncate(ToolName, Text.MaxName),
                DurationMs = Stopwatch.GetElapsedTime(_started).TotalMilliseconds,
                Success = success,
                ErrorSource = source,
                ErrorType = type,
                ErrorMessage = message,
                ClientType = Clients.Detect(ClientName),
                ClientName = Clients.Name(ClientName),
                ClientVersion = Text.Version(ClientVersion),
                ServerVersion = Text.Version(Collector.ServerVersion ?? ServerVersion),
                Timestamp = Timestamp.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", System.Globalization.CultureInfo.InvariantCulture),
                SdkVersion = Version.Current,
                SessionId = SessionId,
                Parameters = Collector.CaptureParameterNames ? DescribedParameters ?? Parameters.Describe(Arguments) : null,
                ResponseBytes = ResponseBytes(response),
                // A tool the server has, refused arguments included: often the schema is why.
                DefinitionHash = Kind is null && source != ErrorSources.UnknownTool ? Definitions.Of(ToolName) : null,
            });
        }
        catch (Exception)
        {
            // Recording a call must never disturb the call itself.
        }
    }
}
