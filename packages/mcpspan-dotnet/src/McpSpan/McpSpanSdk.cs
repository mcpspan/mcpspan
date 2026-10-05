using McpSpan.Internal;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

namespace McpSpan;

/// <summary>
/// Analytics for MCP servers: which tools are called, by which client, how long they take, and which fail.
/// </summary>
/// <remarks>
/// Most servers need only <see cref="Microsoft.Extensions.DependencyInjection.McpSpanServerBuilderExtensions.WithMcpSpan"/>. Without an API key nothing is
/// collected and nothing is sent. Parameter values never leave the process.
/// </remarks>
public static class McpSpanSdk
{
    /// <summary>The SDK's own version, reported with every event.</summary>
    public const string Version = Internal.Version.Current;

    /// <summary>
    /// Starts collecting, or stops if there is no key to collect with. The same settings again change nothing;
    /// different ones replace the running configuration, delivering what it held. Never throws.
    /// </summary>
    public static void Configure(McpSpanOptions options) => Collector.Configure(options ?? new McpSpanOptions());

    /// <summary>
    /// Stops collecting and delivers what is queued, at most a few seconds. What is queued is also delivered as
    /// the process exits, unless <see cref="McpSpanOptions.FlushOnExit"/> is off. Never throws.
    /// </summary>
    public static Task ShutdownAsync(CancellationToken cancellationToken = default) =>
        Collector.ShutdownAsync(cancellationToken);

    /// <summary>
    /// Measures every tool call on a server built from these options, for servers made with
    /// <c>McpServer.Create</c> rather than through dependency injection. Returns the options.
    /// </summary>
    /// <param name="options">The options the server will be created with.</param>
    /// <param name="settings">
    /// Settings, as <see cref="Configure"/> takes them. Without, the SDK is configured from the environment
    /// unless it was configured already.
    /// </param>
    public static McpServerOptions Instrument(McpServerOptions options, McpSpanOptions? settings = null)
    {
        ArgumentNullException.ThrowIfNull(options);

        try
        {
            ConfigureFor(settings);
            AddFilters(options);
        }
        catch (Exception)
        {
            // An options object of an unfamiliar shape is left as it was.
        }

        return options;
    }

    /// <summary>
    /// Records every call to one call-tool handler, for a server <c>Instrument</c> does not cover. On an
    /// instrumented server it records nothing itself, and each call is counted once.
    /// </summary>
    public static McpRequestHandler<CallToolRequestParams, CallToolResult> Track(
        McpRequestHandler<CallToolRequestParams, CallToolResult> handler)
    {
        ArgumentNullException.ThrowIfNull(handler);

        return async (request, cancellationToken) =>
        {
            if (!Collector.Collecting || request.Items.ContainsKey(TrackedKey))
            {
                return await handler(request, cancellationToken).ConfigureAwait(false);
            }

            request.Items[TrackedKey] = true;
            return await ToolCallFilter.Wrap(handler)(request, cancellationToken).ConfigureAwait(false);
        };
    }

    internal const string TrackedKey = "mcpspan.recorded";

    /// <summary>The filter, marking each call so a tracked handler inside it does not count it again.</summary>
    internal static readonly McpRequestFilter<ReadResourceRequestParams, ReadResourceResult> ReadFilter =
        PrimitiveFilters.WrapRead;

    internal static readonly McpRequestFilter<GetPromptRequestParams, GetPromptResult> GetFilter =
        PrimitiveFilters.WrapGet;

    /// <summary>Adds the filters to a server's options, each once however often this is called.</summary>
    internal static void AddFilters(McpServerOptions options)
    {
        if (!options.Filters.Request.CallToolFilters.Contains(Filter))
        {
            options.Filters.Request.CallToolFilters.Add(Filter);
        }

        if (!options.Filters.Request.ReadResourceFilters.Contains(ReadFilter))
        {
            options.Filters.Request.ReadResourceFilters.Add(ReadFilter);
        }

        if (!options.Filters.Request.GetPromptFilters.Contains(GetFilter))
        {
            options.Filters.Request.GetPromptFilters.Add(GetFilter);
        }

        if (!options.Filters.Request.ListToolsFilters.Contains(Definitions.ListFilter))
        {
            options.Filters.Request.ListToolsFilters.Add(Definitions.ListFilter);
        }
    }

    internal static readonly McpRequestFilter<CallToolRequestParams, CallToolResult> Filter = next =>
    {
        var wrapped = ToolCallFilter.Wrap(next);
        return (request, cancellationToken) =>
        {
            request.Items[TrackedKey] = true;
            return wrapped(request, cancellationToken);
        };
    };

    internal static void ConfigureFor(McpSpanOptions? settings)
    {
        if (settings is not null)
        {
            Configure(settings);
        }
        else if (!Collector.Collecting)
        {
            Configure(new McpSpanOptions());
        }
    }
}
