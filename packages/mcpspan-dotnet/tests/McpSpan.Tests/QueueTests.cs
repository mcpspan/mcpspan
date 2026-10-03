using McpSpan.Internal;

namespace McpSpan.Tests;

public sealed class QueueTests
{
    internal static ToolCallEvent Event(int id) => new()
    {
        Id = id.ToString(System.Globalization.CultureInfo.InvariantCulture),
        ToolName = "t", DurationMs = 0, Success = true, ClientType = "unknown", Timestamp = "", SdkVersion = "",
    };

    private static string[] Ids(IEnumerable<ToolCallEvent> events) => [.. events.Select(e => e.Id)];

    [Fact]
    public void Drops_the_oldest_when_full()
    {
        var queue = new EventQueue(3);
        for (var i = 0; i < 5; i++)
        {
            queue.Add(Event(i));
        }

        Assert.Equal(["2", "3", "4"], Ids(queue.Drain(10)));
        Assert.Equal(2, queue.Dropped);
    }

    [Fact]
    public void Restores_a_failed_batch_in_front_and_stays_bounded()
    {
        var queue = new EventQueue(4);
        queue.Add(Event(0));
        queue.Add(Event(1));
        var first = queue.Drain(1);
        queue.Add(Event(2));
        queue.Restore(first);
        Assert.Equal(["0", "1", "2"], Ids(queue.Drain(10)));

        queue.Add(Event(9));
        queue.Restore([Event(5), Event(6), Event(7), Event(8)]);
        Assert.Equal(["6", "7", "8", "9"], Ids(queue.Drain(10)));
        Assert.Equal(1, queue.Dropped);
    }
}
