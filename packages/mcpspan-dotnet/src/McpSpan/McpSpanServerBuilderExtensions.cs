using McpSpan;
using ModelContextProtocol.Server;

namespace Microsoft.Extensions.DependencyInjection;

/// <summary>Instruments an MCP server built through dependency injection.</summary>
public static class McpSpanServerBuilderExtensions
{
    /// <summary>
    /// Measures every tool call the server answers, from tools registered before this call or after:
    /// <code>
    /// builder.Services.AddMcpServer()
    ///     .WithStdioServerTransport()
    ///     .WithToolsFromAssembly()
    ///     .WithMcpSpan(new() { ApiKey = Environment.GetEnvironmentVariable("MCPSPAN_API_KEY") });
    /// </code>
    /// </summary>
    /// <param name="builder">The MCP server builder.</param>
    /// <param name="settings">
    /// Settings, as <see cref="McpSpanSdk.Configure"/> takes them. Without, the SDK is configured from the
    /// environment unless it was configured already.
    /// </param>
    /// <returns>The builder, to go on configuring the server.</returns>
    public static IMcpServerBuilder WithMcpSpan(this IMcpServerBuilder builder, McpSpanOptions? settings = null)
    {
        ArgumentNullException.ThrowIfNull(builder);

        McpSpanSdk.ConfigureFor(settings);

        // Idempotent: the same filter instances are added once, however often this is called.
        builder.Services.Configure<McpServerOptions>(McpSpanSdk.AddFilters);

        return builder;
    }
}
