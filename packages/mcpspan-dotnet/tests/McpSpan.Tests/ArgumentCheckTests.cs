using System.Text.Json.Nodes;
using McpSpan.Internal;

namespace McpSpan.Tests;

public sealed class ArgumentCheckTests
{
    private static readonly string Shared = Path.Combine(
        AppContext.BaseDirectory, "..", "..", "..", "..", "..", "..", "..", "conformance", "argument-checks.json");

    public static TheoryData<string> Cases()
    {
        var data = new TheoryData<string>();
        foreach (var entry in JsonNode.Parse(File.ReadAllText(Shared))!["cases"]!.AsArray())
        {
            data.Add(entry!["case"]!.GetValue<string>());
        }

        return data;
    }

    [Theory]
    [MemberData(nameof(Cases))]
    public void Finds_the_shared_cases_as_every_SDK_does(string name)
    {
        var entry = JsonNode.Parse(File.ReadAllText(Shared))!["cases"]!.AsArray()
            .Single(item => item!["case"]!.GetValue<string>() == name)!;
        var expected = entry["invalid"]!.AsArray().Select(item => item!.GetValue<string>()).ToList();

        Assert.Equal(expected, ArgumentChecks.Invalid(entry["schema"], entry["arguments"]));
    }

    [Fact]
    public void Finds_nothing_without_a_schema() =>
        Assert.Empty(ArgumentChecks.Invalid(null, JsonNode.Parse("""{"passengers":2}""")));
}
