using System.Text.Json;
using System.Text.Json.Nodes;

namespace McpSpan.Internal;

/// <summary>
/// Which top-level arguments of a refused call did not match the tool's input schema (contract, 3.10). The server's
/// own refusal is not read: each validation library words it differently, and some quote the value the agent sent.
/// The arguments are checked here instead, against the schema the server listed, by a small set of rules that never
/// fail what they do not understand. Only names the schema declares come out, so nothing the client made up, and no
/// value, is sent.
/// </summary>
internal static class ArgumentChecks
{
    /// <summary>Names sent at most, per call.</summary>
    private const int MaxNames = 20;

    /// <summary>The declared names whose arguments fail the schema, sorted, at most twenty. Never throws.</summary>
    public static IReadOnlyList<string> Invalid(JsonNode? schema, IDictionary<string, JsonElement>? arguments)
    {
        try
        {
            var values = arguments is null ? new JsonObject() : JsonSerializer.SerializeToNode(arguments);
            return Invalid(schema, values);
        }
        catch (Exception)
        {
            return [];
        }
    }

    /// <inheritdoc cref="Invalid(JsonNode?, IDictionary{string, JsonElement}?)"/>
    public static IReadOnlyList<string> Invalid(JsonNode? schema, JsonNode? arguments)
    {
        try
        {
            if (schema is not JsonObject rules)
            {
                return [];
            }

            if ((arguments ?? new JsonObject()) is not JsonObject values)
            {
                return [];
            }

            var names = new SortedSet<string>(StringComparer.Ordinal);
            if (rules["required"] is JsonArray required)
            {
                foreach (var name in required)
                {
                    if (TextOf(name) is { } text && !values.ContainsKey(text))
                    {
                        names.Add(text);
                    }
                }
            }

            if (rules["properties"] is JsonObject properties)
            {
                foreach (var (name, rule) in properties)
                {
                    if (values.TryGetPropertyValue(name, out var value) && !Matches(rule, value))
                    {
                        names.Add(name);
                    }
                }
            }

            return names.Take(MaxNames).ToList();
        }
        catch (Exception)
        {
            return [];
        }
    }

    /// <summary>Whether a value passes a schema under the checks the contract lists, and only those.</summary>
    private static bool Matches(JsonNode? schema, JsonNode? value)
    {
        if (KindOf(schema) == JsonValueKind.False)
        {
            return false;
        }

        if (schema is not JsonObject rules)
        {
            return true;
        }

        switch (rules["type"])
        {
            case JsonValue single when TextOf(single) is { } type && !IsType(type, value):
                return false;
            case JsonArray types when types.All(name => TextOf(name) is not null)
                                      && !types.Any(name => IsType(TextOf(name)!, value)):
                return false;
        }

        if (rules["enum"] is JsonArray allowed)
        {
            var sent = Definitions.CanonicalText(value);
            if (!allowed.Any(option => Definitions.CanonicalText(option) == sent))
            {
                return false;
            }
        }

        if (rules.TryGetPropertyValue("const", out var constant)
            && Definitions.CanonicalText(constant) != Definitions.CanonicalText(value))
        {
            return false;
        }

        if (NumberOf(value) is { } number)
        {
            if (NumberOf(rules["minimum"]) is { } minimum && number < minimum) return false;
            if (NumberOf(rules["maximum"]) is { } maximum && number > maximum) return false;
            if (NumberOf(rules["exclusiveMinimum"]) is { } above && number <= above) return false;
            if (NumberOf(rules["exclusiveMaximum"]) is { } below && number >= below) return false;
        }

        if (TextOf(value) is { } text)
        {
            // Code points, not UTF-16 units: a character outside the BMP is one.
            var length = text.EnumerateRunes().Count();
            if (NumberOf(rules["minLength"]) is { } shortest && length < shortest) return false;
            if (NumberOf(rules["maxLength"]) is { } longest && length > longest) return false;
        }

        if (value is JsonArray items)
        {
            if (NumberOf(rules["minItems"]) is { } fewest && items.Count < fewest) return false;
            if (NumberOf(rules["maxItems"]) is { } most && items.Count > most) return false;
            var each = rules["items"];
            if ((each is JsonObject || KindOf(each) is JsonValueKind.True or JsonValueKind.False)
                && !items.All(item => Matches(each, item)))
            {
                return false;
            }
        }

        if (value is JsonObject obj)
        {
            if (rules["required"] is JsonArray required
                && required.Any(name => TextOf(name) is { } key && !obj.ContainsKey(key)))
            {
                return false;
            }

            if (rules["properties"] is JsonObject properties)
            {
                foreach (var (name, rule) in properties)
                {
                    if (obj.TryGetPropertyValue(name, out var item) && !Matches(rule, item))
                    {
                        return false;
                    }
                }
            }
        }

        return true;
    }

    private static bool IsType(string type, JsonNode? value) => type switch
    {
        "string" => TextOf(value) is not null,
        "number" => NumberOf(value) is not null,
        "integer" => NumberOf(value) is { } number && number == Math.Truncate(number),
        "boolean" => KindOf(value) is JsonValueKind.True or JsonValueKind.False,
        "object" => value is JsonObject,
        "array" => value is JsonArray,
        "null" => value is null || KindOf(value) == JsonValueKind.Null,
        // A type this list does not know is not checked.
        _ => true,
    };

    private static JsonValueKind KindOf(JsonNode? node) => node switch
    {
        null => JsonValueKind.Null,
        JsonObject => JsonValueKind.Object,
        JsonArray => JsonValueKind.Array,
        _ => node.GetValueKind(),
    };

    private static string? TextOf(JsonNode? node) =>
        KindOf(node) == JsonValueKind.String ? node!.GetValue<string>() : null;

    private static double? NumberOf(JsonNode? node)
    {
        if (KindOf(node) != JsonValueKind.Number)
        {
            return null;
        }

        var number = node!.GetValue<double>();
        return double.IsFinite(number) ? number : null;
    }
}
