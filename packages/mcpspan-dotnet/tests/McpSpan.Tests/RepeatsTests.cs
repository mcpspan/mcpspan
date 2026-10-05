using System.Text.Json;
using McpSpan.Internal;

namespace McpSpan.Tests;

public sealed class RepeatsTests : IDisposable
{
    public void Dispose() => Repeats.Forget();

    private static Dictionary<string, JsonElement> Args(string json) =>
        JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(json)!;

    [Fact]
    public void Tells_a_repeat_of_the_previous_call_to_the_tool_in_the_session_whatever_the_key_order()
    {
        Assert.False(Repeats.Note("r1", "search", Args("""{"to":"WAW","n":2}""")));
        Assert.True(Repeats.Note("r1", "search", Args("""{"n":2,"to":"WAW"}""")));
        Assert.False(Repeats.Note("r1", "search", Args("""{"to":"KRK","n":2}""")));
        Assert.False(Repeats.Note("r1", "book", Args("""{"to":"KRK","n":2}""")));
        Assert.False(Repeats.Note("r2", "search", Args("""{"to":"KRK","n":2}""")));
        Assert.False(Repeats.Note("r1", "list", null));
        Assert.True(Repeats.Note("r1", "list", Args("{}")));
    }

    [Fact]
    public void Forgets_the_oldest_pairs_past_its_bound()
    {
        Repeats.Note("first", "search", Args("""{"to":"WAW"}"""));
        for (var i = 0; i < Repeats.MaxKept; i++)
        {
            Repeats.Note($"s{i}", "search", null);
        }

        Assert.False(Repeats.Note("first", "search", Args("""{"to":"WAW"}""")));
    }
}
