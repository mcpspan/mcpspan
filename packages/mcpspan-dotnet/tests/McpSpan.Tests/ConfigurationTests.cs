using McpSpan.Internal;

namespace McpSpan.Tests;

public sealed class ConfigurationTests
{
    [Fact]
    public async Task Does_nothing_at_all_without_a_key()
    {
        Environment.SetEnvironmentVariable("MCPSPAN_API_KEY", null);
        McpSpanSdk.Configure(new McpSpanOptions());

        Assert.False(Collector.Collecting);
        await McpSpanSdk.ShutdownAsync(TestContext.Current.CancellationToken);
    }

    [Fact]
    public async Task With_a_key_and_no_endpoint_collects_nothing_and_says_so_once()
    {
        Environment.SetEnvironmentVariable("MCPSPAN_ENDPOINT", null);
        Collector.ForgetNoEndpointNotice();
        var said = new List<string>();
        var settings = new McpSpanOptions { ApiKey = "k", OnDiagnostic = said.Add };

        McpSpanSdk.Configure(settings);
        McpSpanSdk.Configure(settings);

        Assert.False(Collector.Collecting);
        Assert.Equal([Collector.NoEndpoint], said);
        await McpSpanSdk.ShutdownAsync(TestContext.Current.CancellationToken);
    }

    [Fact]
    public async Task The_same_settings_again_change_nothing_and_different_ones_replace_them()
    {
        var announcements = 0;
        Collector.SendOverride = (batch, _) =>
        {
            if (batch.Count == 0)
            {
                Interlocked.Increment(ref announcements);
            }

            return Task.CompletedTask;
        };

        try
        {
            var settings = new McpSpanOptions { ApiKey = "k" };
            McpSpanSdk.Configure(settings);
            McpSpanSdk.Configure(settings with { });
            await Task.Delay(200, TestContext.Current.CancellationToken);
            Assert.Equal(1, announcements);

            McpSpanSdk.Configure(settings with { ApiKey = "other" });
            await Task.Delay(200, TestContext.Current.CancellationToken);
            Assert.Equal(2, announcements);
        }
        finally
        {
            await McpSpanSdk.ShutdownAsync(TestContext.Current.CancellationToken);
            Collector.SendOverride = null;
        }
    }

    [Fact]
    public async Task Reads_the_key_from_the_environment()
    {
        Environment.SetEnvironmentVariable("MCPSPAN_API_KEY", "env-key");
        Collector.SendOverride = (_, _) => Task.CompletedTask;

        try
        {
            McpSpanSdk.Configure(new McpSpanOptions());
            Assert.True(Collector.Collecting);
        }
        finally
        {
            Environment.SetEnvironmentVariable("MCPSPAN_API_KEY", null);
            await McpSpanSdk.ShutdownAsync(TestContext.Current.CancellationToken);
            Collector.SendOverride = null;
        }
    }
}
