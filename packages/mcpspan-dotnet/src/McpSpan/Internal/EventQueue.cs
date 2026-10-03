namespace McpSpan.Internal;

/// <summary>
/// Events waiting to be sent, oldest first, bounded: an unreachable endpoint can never grow it until the host
/// runs out of memory. Not thread-safe on its own; the reporter guards it.
/// </summary>
internal sealed class EventQueue(int maxSize)
{
    private readonly LinkedList<ToolCallEvent> _events = new();

    public int Count => _events.Count;

    public int Dropped { get; private set; }

    /// <summary>Queues an event, dropping the oldest when full: what the server does now matters more.</summary>
    public void Add(ToolCallEvent item)
    {
        if (_events.Count >= maxSize)
        {
            _events.RemoveFirst();
            Dropped++;
        }

        _events.AddLast(item);
    }

    public List<ToolCallEvent> Drain(int limit)
    {
        var batch = new List<ToolCallEvent>(Math.Min(limit, _events.Count));
        while (batch.Count < limit && _events.First is { } first)
        {
            batch.Add(first.Value);
            _events.RemoveFirst();
        }

        return batch;
    }

    /// <summary>Puts a batch that failed back in front. If that overflows, the oldest go as usual.</summary>
    public void Restore(IReadOnlyList<ToolCallEvent> batch)
    {
        for (var i = batch.Count - 1; i >= 0; i--)
        {
            _events.AddFirst(batch[i]);
        }

        while (_events.Count > maxSize)
        {
            _events.RemoveFirst();
            Dropped++;
        }
    }

    public void Clear() => _events.Clear();
}
