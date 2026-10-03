using System.Globalization;
using System.Text;

namespace McpSpan.Internal;

/// <summary>Limits the ingest API enforces, and cutting text to them.</summary>
internal static class Text
{
    /// <summary>A tool, an error type, a client, a parameter name. The API refuses a whole batch over it.</summary>
    public const int MaxName = 200;

    /// <summary>Written by developers for developers: mostly safe to keep, and worth reading in full.</summary>
    public const int MaxExceptionMessage = 500;

    /// <summary>Written for a model to read, so more likely to quote what the user asked.</summary>
    public const int MaxResultMessage = 200;

    /// <summary>A version, the server's or the client's.</summary>
    public const int MaxVersion = 100;

    /// <summary>A version as it is sent: trimmed, cut to its limit, or null when there is none.</summary>
    public static string? Version(string? version)
    {
        var trimmed = version?.Trim();
        return string.IsNullOrEmpty(trimmed) ? null : Truncate(trimmed, MaxVersion);
    }

    /// <summary>Cuts text to a limit in characters, never splitting one, with a visible sign of the cut.</summary>
    public static string Truncate(string text, int limit)
    {
        var info = new StringInfo(text);
        if (info.LengthInTextElements <= limit)
        {
            return text;
        }

        return info.SubstringByTextElements(0, limit - 3) + "...";
    }

    /// <summary>The kind and message of an exception a tool threw, each cut to its limit.</summary>
    public static (string Type, string? Message) Describe(Exception exception)
    {
        string message;
        try
        {
            message = exception.Message;
        }
        catch (Exception)
        {
            // A Message that throws is still an exception to describe.
            message = string.Empty;
        }

        return (
            Truncate(exception.GetType().Name, MaxName),
            message.Length > 0 ? Truncate(message, MaxExceptionMessage) : null);
    }

    /// <summary>The text blocks of a result that reported an error, joined and cut. Nothing else is read.</summary>
    public static string? ResultMessage(IEnumerable<string> texts)
    {
        var joined = string.Join(' ', texts).Trim();

        return joined.Length > 0 ? Truncate(joined, MaxResultMessage) : null;
    }
}
