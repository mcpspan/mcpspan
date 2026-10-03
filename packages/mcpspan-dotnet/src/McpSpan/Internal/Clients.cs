namespace McpSpan.Internal;

/// <summary>Client types, as the contract names them (section 7).</summary>
internal static class Clients
{
    // claude-code before claude, which would otherwise swallow it. The official
    // Inspector sends inspector-cli, which is why names are matched as substrings.
    private static readonly (string Pattern, string Type)[] Known =
    [
        ("claude-code", "claude-code"),
        ("claude code", "claude-code"),
        ("claude", "claude"),
        ("cursor", "cursor"),
        ("chatgpt", "chatgpt"),
        ("openai", "chatgpt"),
        ("inspector", "mcp-inspector"),
    ];

    /// <summary>The client type, from the name a client reported: substring match, first match wins.</summary>
    public static string Detect(string? name)
    {
        var lower = name?.Trim().ToLowerInvariant();
        if (string.IsNullOrEmpty(lower))
        {
            return "unknown";
        }

        foreach (var (pattern, type) in Known)
        {
            if (lower.Contains(pattern, StringComparison.Ordinal))
            {
                return type;
            }
        }

        return "other";
    }

    /// <summary>The name as reported, cut to what the API takes.</summary>
    public static string? Name(string? name)
    {
        var trimmed = name?.Trim();

        return string.IsNullOrEmpty(trimmed) ? null : Text.Truncate(trimmed, Text.MaxName);
    }
}
