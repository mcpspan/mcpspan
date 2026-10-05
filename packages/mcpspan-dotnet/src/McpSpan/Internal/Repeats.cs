using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace McpSpan.Internal;

/// <summary>
/// Whether a call repeats the previous call to the same tool in the same session (contract, 3.9): an agent stuck in
/// a loop. Only the answer leaves the process. Kept here is a SHA-256 of the canonical arguments of the latest call
/// per session and tool, never sent: a digest of a short identifier or an enumerated value is found by trying every
/// one.
/// </summary>
internal static class Repeats
{
    /// <summary>Session and tool pairs kept, the oldest forgotten first.</summary>
    public const int MaxKept = 10_000;

    private static readonly object Lock = new();
    private static readonly Dictionary<(string Session, string Tool), LinkedListNode<Entry>> Latest = [];
    private static readonly LinkedList<Entry> ByAge = new();

    /// <summary>
    /// Notes a call's arguments, as the client sent them, and says whether they are the previous call's to the same
    /// tool in the same session. Arguments that cannot be written down are never a repeat. Never throws.
    /// </summary>
    public static bool Note(string sessionId, string toolName, IDictionary<string, JsonElement>? arguments)
    {
        string digest;
        try
        {
            var node = arguments is null ? new JsonObject() : JsonSerializer.SerializeToNode(arguments);
            digest = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(Definitions.CanonicalText(node))));
        }
        catch (Exception)
        {
            return false;
        }

        var key = (sessionId, toolName);
        lock (Lock)
        {
            if (Latest.TryGetValue(key, out var node))
            {
                var repeated = node.Value.Digest == digest;
                ByAge.Remove(node);
                node.Value = node.Value with { Digest = digest };
                ByAge.AddLast(node);
                return repeated;
            }

            Latest[key] = ByAge.AddLast(new Entry(key, digest));
            if (ByAge.Count > MaxKept)
            {
                var oldest = ByAge.First!;
                ByAge.RemoveFirst();
                Latest.Remove(oldest.Value.Key);
            }

            return false;
        }
    }

    /// <summary>For tests: forgets every call.</summary>
    public static void Forget()
    {
        lock (Lock)
        {
            Latest.Clear();
            ByAge.Clear();
        }
    }

    private sealed record Entry((string Session, string Tool) Key, string Digest);
}
