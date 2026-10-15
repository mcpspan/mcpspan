namespace McpSpan.Internal;

/// <summary>The client a call came from, as it named itself (contract, section 7).</summary>
internal static class Clients
{
    /// <summary>The name as reported, cut to what the API takes. The mcpspan server tells clients apart by it (contract, 7).</summary>
    public static string? Name(string? name)
    {
        var trimmed = name?.Trim();

        return string.IsNullOrEmpty(trimmed) ? null : Text.Truncate(trimmed, Text.MaxName);
    }
}
