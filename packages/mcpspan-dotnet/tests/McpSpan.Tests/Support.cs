using McpSpan.Internal;


namespace McpSpan.Tests;

/// <summary>Collects what the SDK would deliver, in memory, for the life of a test.</summary>
internal sealed class Captured : IAsyncDisposable
{
    private readonly List<ToolCallEvent> _events = [];

    public Captured(McpSpanOptions? options = null)
    {
        Environment.SetEnvironmentVariable("MCPSPAN_API_KEY", null);
        Environment.SetEnvironmentVariable("MCPSPAN_ENDPOINT", null);
        Collector.SendOverride = (batch, _) =>
        {
            lock (_events)
            {
                _events.AddRange(batch);
            }

            return Task.CompletedTask;
        };
        McpSpanSdk.Configure((options ?? new McpSpanOptions()) with
        {
            ApiKey = "k",
            FlushInterval = TimeSpan.FromHours(1),
        });
    }

    /// <summary>Everything recorded so far, delivered by shutting down.</summary>
    public async Task<IReadOnlyList<ToolCallEvent>> DeliveredAsync()
    {
        await McpSpanSdk.ShutdownAsync(TestContext.Current.CancellationToken);
        lock (_events)
        {
            return [.. _events];
        }
    }

    public async ValueTask DisposeAsync()
    {
        await McpSpanSdk.ShutdownAsync(TestContext.Current.CancellationToken);
        Collector.SendOverride = null;
    }
}
