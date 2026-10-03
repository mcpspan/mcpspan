using System.Runtime.CompilerServices;

namespace McpSpan.Internal;

/// <summary>
/// Which conversation a call belongs to (contract, section 8). The identifier is ours, random, and never derived
/// from the transport's own, which travels in HTTP headers and would let server logs be joined to it.
/// </summary>
internal static class Sessions
{
    public const int MaxPerConnection = 1_000;

    private sealed class Known
    {
        public readonly Dictionary<string, string> Ids = new();
        public readonly LinkedList<string> Order = new();
    }

    // Weakly keyed by the connection object, so a connection that ends takes its entry with it.
    private static readonly ConditionalWeakTable<object, Known> ByConnection = new();

    /// <summary>
    /// Our identifier for a call, or null for none: over HTTP without a transport session (stateless, and every
    /// endpoint on 2026-07-28) there is none; otherwise one per connection and transport session.
    /// </summary>
    public static string? For(object connection, bool overHttp, string? transportSession)
    {
        if (overHttp && string.IsNullOrEmpty(transportSession))
        {
            return null;
        }

        var key = transportSession ?? string.Empty;
        var known = ByConnection.GetOrCreateValue(connection);

        lock (known)
        {
            if (known.Ids.TryGetValue(key, out var existing))
            {
                known.Order.Remove(key);
                known.Order.AddLast(key);
                return existing;
            }

            var created = Guid.NewGuid().ToString();
            known.Ids[key] = created;
            known.Order.AddLast(key);

            if (known.Order.Count > MaxPerConnection)
            {
                known.Ids.Remove(known.Order.First!.Value);
                known.Order.RemoveFirst();
            }

            return created;
        }
    }
}
