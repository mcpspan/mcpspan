using System.Globalization;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

namespace McpSpan.Internal;

/// <summary>
/// What the server answered to <c>tools/list</c> (contract, 3.11), once per session for the same answer. A client
/// lists the tools at the start of a session and often again; the count that matters is the sessions that were
/// shown the tools, not how often they asked.
/// </summary>
internal static class Listings
{
    /// <summary>Sessions kept, the oldest forgotten first.</summary>
    private const int MaxSessions = 10_000;

    /// <summary>Tools in a listing beyond this are left out.</summary>
    private const int MaxTools = 500;

    private static readonly object Lock = new();
    private static readonly LinkedList<string> Order = new();
    private static readonly Dictionary<string, (LinkedListNode<string> Node, HashSet<string> Signatures)> Sent =
        new(StringComparer.Ordinal);

    /// <summary>Records a listing, leaving out excluded tools. Never throws.</summary>
    public static void Record(RequestContext<ListToolsRequestParams> request, List<ListedTool> tools)
    {
        try
        {
            var registered = request.Server.ServerOptions.ToolCollection;
            var shown = tools
                .Where(tool => registered is null || !registered.TryGetPrimitive(tool.Name, out var known)
                    || !ToolCallFilter.IsExcluded(known))
                .Take(MaxTools)
                .Select(tool => tool with { Name = Text.Truncate(tool.Name, Text.MaxName) })
                .ToList();
            var call = ToolCallFilter.CallFor(request, "tools/list", "listing", arguments: null, described: null);
            var signature = string.Join('\0', shown.Select(tool => tool.Name + '\0' + tool.DefinitionHash));
            if (!First(call.SessionId, signature))
            {
                return;
            }

            Collector.Record(new ToolCallEvent
            {
                Id = Guid.NewGuid().ToString(),
                Kind = "listing",
                ToolName = "tools/list",
                DurationMs = 0,
                Success = true,
                ClientType = "unknown",
                ClientName = Clients.Name(call.ClientName),
                ClientVersion = Text.Version(call.ClientVersion),
                ServerVersion = Text.Version(Collector.ServerVersion ?? call.ServerVersion),
                Timestamp = call.Timestamp.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture),
                SdkVersion = Version.Current,
                SessionId = call.SessionId,
                ListedTools = shown,
            });
        }
        catch (Exception)
        {
            // Recording must never disturb the answer the client gets.
        }
    }

    /// <summary>Whether a listing is new for its session, noting it as sent. One with no session always is.</summary>
    internal static bool First(string? sessionId, string signature)
    {
        if (sessionId is null)
        {
            return true;
        }

        lock (Lock)
        {
            if (Sent.TryGetValue(sessionId, out var sent))
            {
                if (!sent.Signatures.Add(signature))
                {
                    return false;
                }

                Order.Remove(sent.Node);
                Order.AddLast(sent.Node);
                return true;
            }

            Sent[sessionId] = (Order.AddLast(sessionId), [signature]);
            if (Order.Count > MaxSessions)
            {
                Sent.Remove(Order.First!.Value);
                Order.RemoveFirst();
            }

            return true;
        }
    }

    /// <summary>For tests: forgets every listing sent.</summary>
    internal static void Forget()
    {
        lock (Lock)
        {
            Sent.Clear();
            Order.Clear();
        }
    }
}
