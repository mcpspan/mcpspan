using System.Text.Json;

namespace McpSpan.Internal;

/// <summary>Parameter names and JSON types, never values (contract, section 5).</summary>
internal static class Parameters
{
    /// <summary>Bounds one call's description, so a very wide object cannot make a large event.</summary>
    public const int MaxDescribed = 50;

    public static IReadOnlyDictionary<string, string>? Describe(IDictionary<string, JsonElement>? arguments)
    {
        if (arguments is null || arguments.Count == 0)
        {
            return null;
        }

        var described = new Dictionary<string, string>();
        foreach (var (name, value) in arguments)
        {
            if (described.Count >= MaxDescribed)
            {
                break;
            }

            described[Text.Truncate(name, Text.MaxName)] = value.ValueKind switch
            {
                JsonValueKind.String => "string",
                JsonValueKind.Number => "number",
                JsonValueKind.True or JsonValueKind.False => "boolean",
                JsonValueKind.Object => "object",
                JsonValueKind.Array => "array",
                _ => "null",
            };
        }

        return described;
    }
}
