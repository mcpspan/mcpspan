using System.IO.Pipelines;
using McpSpan.Internal;
using Microsoft.Extensions.DependencyInjection;
using ModelContextProtocol.Client;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

namespace McpSpan.Tests;

internal sealed class BookingException(string message) : Exception(message);

[McpServerToolType]
internal sealed class FlightTools
{
    [McpServerTool(Name = "ok")]
    public static string Ok() => "ok";

    [McpServerTool(Name = "reported_error")]
    public static CallToolResult ReportedError() =>
        new() { IsError = true, Content = [new TextContentBlock { Text = "No flights found" }] };

    [McpServerTool(Name = "throws")]
    public static string Throws() => throw new BookingException("seat map unavailable");

    [McpServerTool(Name = "typed")]
    public static string Typed(string destination, double passengers) => destination;

    // Throws the same type binding does, from inside the tool: a failure of the tool, not a refusal.
    [McpServerTool(Name = "own_argument_check")]
    public static string OwnArgumentCheck() => throw new ArgumentException("not today");

    [McpServerTool(Name = "health"), McpSpanExclude]
    public static string Health(double depth) => "ok";
}

[McpServerToolType]
internal sealed class LaterTools
{
    [McpServerTool(Name = "later")]
    public static string Later() => "later";
}

/// <summary>A server built through dependency injection, and a real client talking to it in memory.</summary>
internal sealed class Connection : IAsyncDisposable
{
    private readonly ServiceProvider _services;
    private readonly McpClient _client;

    private Connection(ServiceProvider services, McpClient client)
    {
        _services = services;
        _client = client;
    }

    public static async Task<Connection> OpenAsync(
        Action<IMcpServerBuilder> build, string clientName = "claude-code", string? serverVersion = null)
    {
        var clientToServer = new Pipe();
        var serverToClient = new Pipe();
        var services = new ServiceCollection();
        services.AddLogging();
        var builder = services.AddMcpServer(options =>
            {
                if (serverVersion is not null)
                {
                    options.ServerInfo = new() { Name = "flights", Version = serverVersion };
                }
            })
            .WithStreamServerTransport(clientToServer.Reader.AsStream(), serverToClient.Writer.AsStream());
        build(builder);

        var provider = services.BuildServiceProvider();
        _ = provider.GetRequiredService<McpServer>().RunAsync();

        var client = await McpClient.CreateAsync(
            new StreamClientTransport(clientToServer.Writer.AsStream(), serverToClient.Reader.AsStream()),
            new McpClientOptions { ClientInfo = new() { Name = clientName, Version = "1.0.0" } });

        return new Connection(provider, client);
    }

    public async Task<CallToolResult?> CallAsync(string name, Dictionary<string, object?>? arguments = null)
    {
        try
        {
            return await _client.CallToolAsync(name, arguments ?? []);
        }
        catch (Exception)
        {
            return null;
        }
    }

    /// <summary>Reads a resource, swallowing the error a refusal comes back as.</summary>
    public async Task ReadAsync(string uri)
    {
        try
        {
            await _client.ReadResourceAsync(uri);
        }
        catch (Exception)
        {
        }
    }

    /// <summary>Gets a prompt, swallowing the error a refusal comes back as.</summary>
    public async Task GetPromptAsync(string name, Dictionary<string, object?>? arguments = null)
    {
        try
        {
            await _client.GetPromptAsync(name, arguments ?? []);
        }
        catch (Exception)
        {
        }
    }

    public async ValueTask DisposeAsync()
    {
        await _client.DisposeAsync();
        await _services.DisposeAsync();
    }
}

public sealed class ServerTests
{
    private static Dictionary<string, ToolCallEvent> ByTool(IEnumerable<ToolCallEvent> events) =>
        events.GroupBy(e => e.ToolName).ToDictionary(g => g.Key, g => g.Last());

    [Fact]
    public async Task Records_each_kind_of_outcome_and_leaves_the_answers_alone()
    {
        await using var captured = new Captured();
        CallToolResult?[] results;
        await using (var connection = await Connection.OpenAsync(b => b.WithTools<FlightTools>().WithMcpSpan()))
        {
            results = [
                await connection.CallAsync("ok"),
                await connection.CallAsync("reported_error"),
                await connection.CallAsync("throws"),
            ];
        }

        var events = ByTool(await captured.DeliveredAsync());
        Assert.True(events["ok"].Success);
        Assert.Null(events["ok"].ErrorSource);
        Assert.Equal(("result", "No flights found"), (events["reported_error"].ErrorSource, events["reported_error"].ErrorMessage));
        Assert.Equal(("exception", "BookingException", "seat map unavailable"),
            (events["throws"].ErrorSource, events["throws"].ErrorType, events["throws"].ErrorMessage));
        Assert.Equal([null, true, true], results.Select(r => r?.IsError));
    }

    [Fact]
    public async Task Sends_no_error_message_when_told_not_to_and_still_says_how_each_call_failed()
    {
        await using var captured = new Captured(new McpSpanOptions { CaptureErrorMessages = false });
        await using (var connection = await Connection.OpenAsync(b => b.WithTools<FlightTools>().WithMcpSpan()))
        {
            await connection.CallAsync("reported_error");
            await connection.CallAsync("throws");
        }

        var events = ByTool(await captured.DeliveredAsync());
        Assert.Equal(("result", null), (events["reported_error"].ErrorSource, events["reported_error"].ErrorMessage));
        Assert.Equal(("exception", "BookingException", null),
            (events["throws"].ErrorSource, events["throws"].ErrorType, events["throws"].ErrorMessage));
    }

    [Fact]
    public async Task Records_refused_calls_without_a_message()
    {
        await using var captured = new Captured();
        await using (var connection = await Connection.OpenAsync(b => b.WithTools<FlightTools>().WithMcpSpan()))
        {
            await connection.CallAsync("typed", new() { ["destination"] = "WAW", ["passengers"] = "two" });
            await connection.CallAsync("typed", new() { ["destination"] = "WAW" });
            await connection.CallAsync("no_such_tool");
        }

        var events = await captured.DeliveredAsync();
        Assert.Equal(
            [("typed", "arguments"), ("typed", "arguments"), ("no_such_tool", "unknown_tool")],
            events.Select(e => (e.ToolName, e.ErrorSource)));
        Assert.All(events, e => Assert.Null(e.ErrorMessage));
    }

    [Fact]
    public async Task A_tool_throwing_what_binding_throws_is_still_the_tools_failure()
    {
        await using var captured = new Captured();
        await using (var connection = await Connection.OpenAsync(b => b.WithTools<FlightTools>().WithMcpSpan()))
        {
            await connection.CallAsync("own_argument_check");
        }

        var recorded = Assert.Single(await captured.DeliveredAsync());
        Assert.Equal(("exception", "ArgumentException"), (recorded.ErrorSource, recorded.ErrorType));
    }

    [Fact]
    public async Task Leaves_an_excluded_tool_out_even_when_refused()
    {
        await using var captured = new Captured();
        await using (var connection = await Connection.OpenAsync(b => b.WithTools<FlightTools>().WithMcpSpan()))
        {
            await connection.CallAsync("health", new() { ["depth"] = 1 });
            await connection.CallAsync("health", new() { ["depth"] = "deep" });
            await connection.CallAsync("ok");
        }

        Assert.Equal(["ok"], (await captured.DeliveredAsync()).Select(e => e.ToolName));
    }

    [Fact]
    public async Task Measures_tools_registered_before_and_after()
    {
        await using var captured = new Captured();
        await using (var connection = await Connection.OpenAsync(b => b.WithTools<FlightTools>().WithMcpSpan().WithTools<LaterTools>()))
        {
            await connection.CallAsync("ok");
            await connection.CallAsync("later");
        }

        Assert.Equal(["ok", "later"], (await captured.DeliveredAsync()).Select(e => e.ToolName));
    }

    [Fact]
    public async Task Records_the_versions_the_server_and_the_client_give_themselves()
    {
        await using var captured = new Captured();
        await using (var connection = await Connection.OpenAsync(b => b.WithTools<FlightTools>().WithMcpSpan(), serverVersion: "3.1.4"))
        {
            await connection.CallAsync("ok");
            await connection.CallAsync("no_such_tool");
        }

        Assert.All(await captured.DeliveredAsync(), e => Assert.Equal(("3.1.4", "1.0.0"), (e.ServerVersion, e.ClientVersion)));
    }

    [Fact]
    public async Task A_version_set_for_the_sdk_wins_over_the_servers_own()
    {
        await using var captured = new Captured(new McpSpanOptions { ServerVersion = "a1b2c3d" });
        await using (var connection = await Connection.OpenAsync(b => b.WithTools<FlightTools>().WithMcpSpan(), serverVersion: "3.1.4"))
        {
            await connection.CallAsync("ok");
        }

        Assert.Equal("a1b2c3d", Assert.Single(await captured.DeliveredAsync()).ServerVersion);
    }

    [Fact]
    public async Task The_client_and_one_session_per_connection_and_another_for_the_next()
    {
        await using var captured = new Captured();
        await using (var connection = await Connection.OpenAsync(b => b.WithTools<FlightTools>().WithMcpSpan(), "Claude Desktop"))
        {
            await connection.CallAsync("ok");
            await connection.CallAsync("typed", new());
            await connection.CallAsync("no_such_tool");
        }

        await using (var connection = await Connection.OpenAsync(b => b.WithTools<FlightTools>().WithMcpSpan(), "cursor-vscode"))
        {
            await connection.CallAsync("ok");
        }

        var events = await captured.DeliveredAsync();
        Assert.Equal(["claude", "claude", "claude", "cursor"], events.Select(e => e.ClientType));
        Assert.Equal("Claude Desktop", events[0].ClientName);
        Assert.All(events, e => Assert.NotNull(e.SessionId));
        Assert.Single(events.Take(3).Select(e => e.SessionId).Distinct());
        Assert.NotEqual(events[0].SessionId, events[3].SessionId);
    }

    [Fact]
    public async Task Instrumenting_twice_counts_once()
    {
        await using var captured = new Captured();
        await using (var connection = await Connection.OpenAsync(b => b.WithTools<FlightTools>().WithMcpSpan().WithMcpSpan()))
        {
            await connection.CallAsync("ok");
        }

        Assert.Single(await captured.DeliveredAsync());
    }

    [Fact]
    public async Task Track_measures_a_handler_of_its_own_and_counts_once_when_instrumented()
    {
        McpRequestHandler<CallToolRequestParams, CallToolResult> handler = (_, _) =>
            ValueTask.FromResult(new CallToolResult { Content = [new TextContentBlock { Text = "ok" }] });

        await using var captured = new Captured();
        await using (var connection = await Connection.OpenAsync(b => b.WithCallToolHandler(McpSpanSdk.Track(handler))))
        {
            await connection.CallAsync("by_hand");
        }

        await using (var connection = await Connection.OpenAsync(b => b.WithCallToolHandler(McpSpanSdk.Track(handler)).WithMcpSpan()))
        {
            await connection.CallAsync("by_hand");
        }

        Assert.Equal(["by_hand", "by_hand"], (await captured.DeliveredAsync()).Select(e => e.ToolName));
    }

    [Fact]
    public async Task Unconfigured_the_server_works_and_nothing_is_recorded()
    {
        Environment.SetEnvironmentVariable("MCPSPAN_API_KEY", null);
        await McpSpanSdk.ShutdownAsync(TestContext.Current.CancellationToken);

        await using var connection = await Connection.OpenAsync(b => b.WithTools<FlightTools>().WithMcpSpan());
        var result = await connection.CallAsync("ok");

        Assert.Equal("ok", (result!.Content[0] as TextContentBlock)!.Text);
        Assert.False(Collector.Collecting);
    }
}
