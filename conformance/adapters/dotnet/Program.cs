// The conformance adapter for the .NET SDK, on the official MCP C# SDK.
//
// Build it, then point the suite at it:
//
//   dotnet build -c Release -o out && CONFORMANCE_ADAPTER='["dotnet", "adapters/dotnet/out/Adapter.dll"]' ...
using System.ComponentModel;
using McpSpan;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

var builder = Host.CreateApplicationBuilder(args);

// Standard output carries the protocol: every log line goes to standard error.
builder.Logging.AddConsole(options => options.LogToStandardErrorThreshold = LogLevel.Trace);

var flushMs = int.TryParse(Environment.GetEnvironmentVariable("CONFORMANCE_FLUSH_MS"), out var ms) ? ms : 200;

builder.Services.AddMcpServer(options => options.ServerInfo = new() { Name = "conformance", Version = "1.0.0" })
    .WithStdioServerTransport()
    // Before WithMcpSpan, as the contract requires an SDK to measure too.
    .WithTools<EarlyTools>()
    .WithMcpSpan(new McpSpanOptions
    {
        Endpoint = Environment.GetEnvironmentVariable("MCPSPAN_ENDPOINT"),
        FlushInterval = TimeSpan.FromMilliseconds(flushMs),
        CaptureParameterNames = Environment.GetEnvironmentVariable("CONFORMANCE_CAPTURE_PARAMETERS") == "1",
        CaptureErrorMessages = Environment.GetEnvironmentVariable("CONFORMANCE_CAPTURE_ERROR_MESSAGES") != "0",
    })
    .WithTools<ConformanceTools>()
    .WithTools([new LongNamedTool()])
    .WithResources<ConformanceResources>()
    .WithPrompts<ConformancePrompts>();

// Returns when standard input closes, as the client leaves. What is queued is delivered as the process exits.
await builder.Build().RunAsync();

internal sealed class ConformanceError(string message) : Exception(message);

[McpServerToolType]
internal sealed class EarlyTools
{
    [McpServerTool(Name = "early")]
    public static string Early() => "ok";
}

[McpServerToolType]
internal sealed class ConformanceTools
{
    [McpServerTool(Name = "ok")]
    public static string Ok() => "ok";

    [McpServerTool(Name = "large")]
    public static string Large() => new('x', 100_000);

    [McpServerTool(Name = "reported_error")]
    public static CallToolResult ReportedError() =>
        new() { IsError = true, Content = [new TextContentBlock { Text = "No flights found" }] };

    [McpServerTool(Name = "throws")]
    public static string Throws() => throw new ConformanceError("boom");

    [McpServerTool(Name = "typed")]
    public static string Typed(string destination, double passengers) => "ok";

    [McpServerTool(Name = "excluded"), McpSpanExclude, Description("Left out.")]
    public static string Excluded(double depth) => "ok";
}

/// <summary>
/// Resources (contract, 3.5): one at a fixed address, one read through a template, one that throws.
/// </summary>
[McpServerResourceType]
internal sealed class ConformanceResources
{
    [McpServerResource(UriTemplate = "config://app", Name = "config")]
    public static string Config() => "ok";

    [McpServerResource(UriTemplate = "trips://{id}", Name = "trip")]
    public static string Trip(string id) => "ok";

    [McpServerResource(UriTemplate = "broken://status", Name = "broken")]
    public static string Broken() => throw new ConformanceError("boom");
}

/// <summary>Prompts (contract, 3.5): one with a required argument, and one that throws.</summary>
[McpServerPromptType]
internal sealed class ConformancePrompts
{
    [McpServerPrompt(Name = "plan_trip")]
    public static string PlanTrip(string destination) => $"Plan a trip to {destination}";

    [McpServerPrompt(Name = "broken_prompt")]
    public static string BrokenPrompt() => throw new ConformanceError("boom");
}

/// <summary>
/// The tool with a name longer than the API takes. The MCP SDK refuses to build a tool named past 128
/// characters, so this one is made by hand, as any custom tool can be.
/// </summary>
internal sealed class LongNamedTool : McpServerTool
{
    public override Tool ProtocolTool { get; } = new()
    {
        Name = "long_" + new string('x', 295),
        InputSchema = System.Text.Json.JsonDocument.Parse("{\"type\":\"object\"}").RootElement,
    };

    public override IReadOnlyList<object> Metadata { get; } = [];

    public override ValueTask<CallToolResult> InvokeAsync(
        RequestContext<CallToolRequestParams> request, CancellationToken cancellationToken = default) =>
        ValueTask.FromResult(new CallToolResult { Content = [new TextContentBlock { Text = "ok" }] });
}
