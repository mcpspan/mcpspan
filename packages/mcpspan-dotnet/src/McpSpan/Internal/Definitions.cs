using System.Collections.Concurrent;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using ModelContextProtocol;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

namespace McpSpan.Internal;

/// <summary>
/// Tool definitions as the server lists them, fingerprinted (contract, 3.8). Rewording a description can change how
/// agents use a tool more than a change to its code; the fingerprint is taken from the answer to <c>tools/list</c>,
/// what an agent actually read, and sent with every call to the tool. Kept for the process: one process reports to
/// one server.
/// </summary>
internal static class Definitions
{
    private static readonly ConcurrentDictionary<string, string> Listed = new(StringComparer.Ordinal);

    private static readonly string[] Hashed = ["name", "title", "description", "inputSchema"];

    /// <summary>The filter that notes every listing.</summary>
    public static readonly McpRequestFilter<ListToolsRequestParams, ListToolsResult> ListFilter = next =>
        async (request, cancellationToken) =>
        {
            var result = await next(request, cancellationToken).ConfigureAwait(false);
            if (Collector.Collecting)
            {
                Note(result.Tools);
            }

            return result;
        };

    /// <summary>The latest fingerprint listed for a tool, or null when no listing in this process named it.</summary>
    public static string? Of(string toolName) => Listed.TryGetValue(toolName, out var hash) ? hash : null;

    /// <summary>Notes every tool in a listing. Never throws.</summary>
    public static void Note(IEnumerable<Tool>? tools)
    {
        try
        {
            foreach (var tool in tools ?? [])
            {
                var wire = JsonSerializer.SerializeToNode(tool, McpJsonUtilities.DefaultOptions) as JsonObject;
                var hash = wire is null ? null : Hash(wire);
                if (hash is not null && tool.Name is not null)
                {
                    Listed[tool.Name] = hash;
                }
            }
        }
        catch (Exception)
        {
            // A listing that cannot be read leaves the fingerprints as they were.
        }
    }

    /// <summary>For tests: forgets every listing.</summary>
    public static void Forget() => Listed.Clear();

    /// <summary>
    /// The first 16 hex characters of the SHA-256 of the tool's name, title, description and input schema, as
    /// canonical JSON; null for a definition that cannot be written so.
    /// </summary>
    public static string? Hash(JsonObject tool)
    {
        try
        {
            var hashed = new SortedDictionary<string, JsonNode?>(StringComparer.Ordinal);
            foreach (var field in Hashed)
            {
                if (tool.TryGetPropertyValue(field, out var value) && value is not null)
                {
                    hashed[field] = value;
                }
            }

            var text = new StringBuilder();
            text.Append('{');
            var first = true;
            foreach (var (key, value) in hashed)
            {
                if (!first)
                {
                    text.Append(',');
                }

                first = false;
                Text(text, key);
                text.Append(':');
                Canonical(text, value);
            }

            text.Append('}');
            var digest = SHA256.HashData(Encoding.UTF8.GetBytes(text.ToString()));
            return Convert.ToHexString(digest)[..16].ToLowerInvariant();
        }
        catch (Exception)
        {
            return null;
        }
    }

    /// <summary>Sorted keys, no whitespace, minimal escaping: the same text in every SDK.</summary>
    private static void Canonical(StringBuilder text, JsonNode? node)
    {
        switch (node)
        {
            case null:
                text.Append("null");
                break;
            case JsonObject obj:
                text.Append('{');
                var first = true;
                foreach (var (key, value) in obj.OrderBy(pair => pair.Key, StringComparer.Ordinal))
                {
                    if (!first)
                    {
                        text.Append(',');
                    }

                    first = false;
                    Text(text, key);
                    text.Append(':');
                    Canonical(text, value);
                }

                text.Append('}');
                break;
            case JsonArray array:
                text.Append('[');
                for (var i = 0; i < array.Count; i++)
                {
                    if (i > 0)
                    {
                        text.Append(',');
                    }

                    Canonical(text, array[i]);
                }

                text.Append(']');
                break;
            case JsonValue value:
                var element = value.GetValue<JsonElement>();
                switch (element.ValueKind)
                {
                    case JsonValueKind.String:
                        Text(text, element.GetString()!);
                        break;
                    case JsonValueKind.True:
                        text.Append("true");
                        break;
                    case JsonValueKind.False:
                        text.Append("false");
                        break;
                    case JsonValueKind.Null:
                        text.Append("null");
                        break;
                    case JsonValueKind.Number when element.TryGetInt64(out var integer):
                        text.Append(integer.ToString(CultureInfo.InvariantCulture));
                        break;
                    case JsonValueKind.Number:
                        var number = element.GetDouble();
                        text.Append(number == Math.Floor(number) && Math.Abs(number) < 1e15
                            ? ((long)number).ToString(CultureInfo.InvariantCulture)
                            : number.ToString("R", CultureInfo.InvariantCulture));
                        break;
                    default:
                        throw new JsonException($"cannot fingerprint {element.ValueKind}");
                }

                break;
        }
    }

    private static void Text(StringBuilder text, string value)
    {
        text.Append('"');
        foreach (var character in value)
        {
            switch (character)
            {
                case '"': text.Append("\\\""); break;
                case '\\': text.Append("\\\\"); break;
                case '\b': text.Append("\\b"); break;
                case '\f': text.Append("\\f"); break;
                case '\n': text.Append("\\n"); break;
                case '\r': text.Append("\\r"); break;
                case '\t': text.Append("\\t"); break;
                default:
                    if (character < 0x20)
                    {
                        text.Append(CultureInfo.InvariantCulture, $"\\u{(int)character:x4}");
                    }
                    else
                    {
                        text.Append(character);
                    }

                    break;
            }
        }

        text.Append('"');
    }
}
