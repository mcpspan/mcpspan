using McpSpan.Internal;

namespace McpSpan.Tests;

public sealed class TextTests
{
    [Fact]
    public void Truncate_marks_a_cut_and_keeps_characters_whole()
    {
        Assert.Equal("abc", Text.Truncate("abc", 5));
        Assert.Equal("ab...", Text.Truncate("abcdefgh", 5));
        var cut = Text.Truncate(new string('ż', 300), 200);
        Assert.Equal(200, cut.Length);
        Assert.EndsWith("...", cut, StringComparison.Ordinal);
    }

    private sealed class BookingException(string message) : Exception(message);

    [Fact]
    public void Describes_an_exception_by_its_type_and_message()
    {
        Assert.Equal(("BookingException", "boom"), Text.Describe(new BookingException("boom")));
        Assert.Equal(500, Text.Describe(new InvalidOperationException(new string('m', 1000))).Message!.Length);
    }

    [Fact]
    public void Joins_result_text_and_cuts_it()
    {
        Assert.Equal("No flights found", Text.ResultMessage(["No flights", "found"]));
        Assert.Null(Text.ResultMessage([]));
        Assert.Equal(200, Text.ResultMessage([new string('x', 1000)])!.Length);
    }

    /// <summary>The contract's table as cases, shared by every SDK's tests (conformance/client-types.json).</summary>
    public static TheoryData<string?, string> ContractTable()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "conformance", "client-types.json")))
        {
            directory = directory.Parent;
        }

        using var document = System.Text.Json.JsonDocument.Parse(
            File.ReadAllText(Path.Combine(directory!.FullName, "conformance", "client-types.json")));
        var data = new TheoryData<string?, string>();
        foreach (var entry in document.RootElement.GetProperty("cases").EnumerateArray())
        {
            data.Add(entry[0].GetString(), entry[1].GetString()!);
        }

        return data;
    }

    [Theory]
    [MemberData(nameof(ContractTable))]
    public void Detects_the_contract_table(string? name, string expected) =>
        Assert.Equal(expected, Clients.Detect(name));

    [Fact]
    public void Keeps_the_client_name_but_cuts_it()
    {
        Assert.Equal("cursor", Clients.Name(" cursor "));
        Assert.Equal(200, Clients.Name(new string('c', 400))!.Length);
        Assert.Null(Clients.Name(" "));
    }

    [Fact]
    public void Describes_parameters_by_name_and_JSON_type_only()
    {
        using var document = System.Text.Json.JsonDocument.Parse(
            """{"destination":"secret","passengers":2,"direct":true,"stops":[],"filters":{},"note":null}""");
        var arguments = document.RootElement.EnumerateObject().ToDictionary(p => p.Name, p => p.Value.Clone());

        var described = Parameters.Describe(arguments)!;

        Assert.Equal(
            new Dictionary<string, string>
            {
                ["destination"] = "string", ["passengers"] = "number", ["direct"] = "boolean",
                ["stops"] = "array", ["filters"] = "object", ["note"] = "null",
            },
            described);
        Assert.DoesNotContain("secret", string.Join(",", described.Values), StringComparison.Ordinal);
        Assert.Null(Parameters.Describe(new Dictionary<string, System.Text.Json.JsonElement>()));
    }

    [Fact]
    public void Measures_an_answer_as_the_MCP_SDK_encodes_it()
    {
        var result = new ModelContextProtocol.Protocol.CallToolResult
        {
            Content = [new ModelContextProtocol.Protocol.TextContentBlock { Text = new string('x', 1000) }],
        };
        var encoded = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(
            result, ModelContextProtocol.McpJsonUtilities.DefaultOptions);

        Assert.Equal(encoded.LongLength, Call.ResponseBytes(result));
        Assert.InRange(encoded.LongLength, 1000, 1100);
    }

    [Fact]
    public void Has_no_size_for_no_answer_or_one_that_cannot_be_encoded()
    {
        Assert.Null(Call.ResponseBytes(null));
        Assert.Null(Call.ResponseBytes(new Action(() => { })));
    }
}
