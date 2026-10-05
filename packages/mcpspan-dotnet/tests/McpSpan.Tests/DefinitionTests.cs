using System.Text.Json;
using System.Text.Json.Nodes;
using McpSpan.Internal;

namespace McpSpan.Tests;

public sealed class DefinitionTests
{
    private static readonly string Shared = Path.Combine(
        AppContext.BaseDirectory, "..", "..", "..", "..", "..", "..", "..", "conformance", "definition-hashes.json");

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
    public void Fingerprints_the_shared_cases_as_every_SDK_does(string name)
    {
        var entry = JsonNode.Parse(File.ReadAllText(Shared))!["cases"]!.AsArray()
            .Single(item => item!["case"]!.GetValue<string>() == name)!;
        var tool = JsonNode.Parse(entry["tool"]!.ToJsonString())!.AsObject();

        Assert.Equal(entry["hash"]!.GetValue<string>(), Definitions.Hash(tool));
    }

    [Fact]
    public void Keeps_the_latest_listed_fingerprint_of_each_tool()
    {
        Definitions.Note([new() { Name = "fp_a", Description = "one" }, new() { Name = "fp_b" }]);
        Definitions.Note([new() { Name = "fp_a", Description = "two" }]);
        Definitions.Note(null);

        var expected = Definitions.Hash(JsonNode.Parse("""{"name":"fp_a","description":"two","inputSchema":{"type":"object"}}""")!.AsObject());
        Assert.Equal(expected, Definitions.Of("fp_a"));
        Assert.NotNull(Definitions.Of("fp_b"));
        Assert.Null(Definitions.Of("fp_c"));
    }
}
