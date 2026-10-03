namespace McpSpan.Internal;

/// <summary>
/// Collects events and delivers them from a background task.
/// </summary>
/// <remarks>
/// <see cref="Record"/> is the only method a tool call touches, and it only appends to memory under a lock.
/// Delivery runs on the thread pool, whose threads never keep a process alive.
/// </remarks>
internal sealed class Reporter : IDisposable
{
    public static readonly TimeSpan DefaultFlushInterval = TimeSpan.FromSeconds(5);
    public const int DefaultMaxBatchSize = 100;
    public const int DefaultMaxQueueSize = 10_000;

    private static readonly TimeSpan InitialRetryDelay = TimeSpan.FromSeconds(1);
    private static readonly TimeSpan MaxRetryDelay = TimeSpan.FromMinutes(1);

    private readonly Func<IReadOnlyList<ToolCallEvent>, CancellationToken, Task> _send;
    private readonly string _endpoint;
    private readonly TimeSpan _flushInterval;
    private readonly int _maxBatchSize;
    private readonly bool _debug;
    private readonly Action<string>? _onDiagnostic;
    private readonly IDisposable? _transport;

    private readonly object _gate = new();
    private readonly EventQueue _queue;
    private readonly SemaphoreSlim _sending = new(1, 1);
    private readonly SemaphoreSlim _wake = new(0, 1);
    private readonly CancellationTokenSource _stopping = new();

    private int _reportedDrops;
    private int _failures;
    private DateTimeOffset _nextAttempt = DateTimeOffset.MinValue;
    private volatile bool _rejected;
    private volatile bool _stopped;
    private Task? _loop;

    public Reporter(
        string endpoint,
        TimeSpan flushInterval,
        int maxBatchSize,
        int maxQueueSize,
        bool debug,
        Action<string>? onDiagnostic,
        Func<IReadOnlyList<ToolCallEvent>, CancellationToken, Task> send,
        IDisposable? transport = null)
    {
        _endpoint = endpoint;
        _flushInterval = flushInterval;
        _maxBatchSize = maxBatchSize;
        _debug = debug;
        _onDiagnostic = onDiagnostic;
        _send = send;
        _transport = transport;
        _queue = new EventQueue(maxQueueSize);
    }

    /// <summary>The wait after the n-th consecutive failure: doubling to a ceiling, spread over its second half.</summary>
    public static TimeSpan Backoff(int failures, Func<double> random)
    {
        var ceiling = Math.Min(MaxRetryDelay.TotalMilliseconds, InitialRetryDelay.TotalMilliseconds * Math.Pow(2, failures - 1));

        return TimeSpan.FromMilliseconds(ceiling / 2 + random() * ceiling / 2);
    }

    /// <summary>Starts delivery, announcing the server first (contract, 3.4).</summary>
    public void Start() => _loop = Task.Run(RunAsync);

    /// <summary>Queues an event and returns at once.</summary>
    public void Record(ToolCallEvent item)
    {
        if (_stopped || _rejected)
        {
            return;
        }

        bool full;
        lock (_gate)
        {
            _queue.Add(item);
            full = _queue.Count >= _maxBatchSize;
        }

        if (full)
        {
            Wake();
        }
    }

    /// <summary>
    /// Stops delivery and makes a final attempt at what is queued, ignoring any retry delay: this is the last
    /// chance these events get. Waits for a delivery already under way rather than posting its events twice.
    /// </summary>
    public async Task StopAsync(TimeSpan timeout)
    {
        _stopped = true;
        await _stopping.CancelAsync().ConfigureAwait(false);

        try
        {
            await DeliverAsync(force: true, timeout).WaitAsync(timeout).ConfigureAwait(false);
        }
        catch (Exception)
        {
            // Out of time, or anything else: what could not be sent is lost with the process, as it would be.
        }
    }

    private void Wake()
    {
        try
        {
            _wake.Release();
        }
        catch (SemaphoreFullException)
        {
            // Already woken.
        }
    }

    private async Task RunAsync()
    {
        try
        {
            await AnnounceAsync().ConfigureAwait(false);

            while (!_stopped && !_rejected)
            {
                try
                {
                    await _wake.WaitAsync(_flushInterval, _stopping.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    return;
                }

                await DeliverAsync(force: false, Transport.Timeout).ConfigureAwait(false);
            }
        }
        catch (Exception exception)
        {
            // Nothing may escape into the host, not even from a background task.
            Log($"mcpspan: delivery stopped ({exception.Message})");
        }
    }

    private async Task AnnounceAsync()
    {
        try
        {
            await _send([], _stopping.Token).ConfigureAwait(false);
        }
        catch (TransportException exception) when (exception.Status is 401 or 403)
        {
            Reject(exception.Status.Value);
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            Log($"mcpspan: could not announce this server to {_endpoint} ({exception.Message}). " +
                "Events will still be delivered once it answers.");
        }
    }

    private async Task DeliverAsync(bool force, TimeSpan wait)
    {
        if (_rejected || (!force && DateTimeOffset.UtcNow < _nextAttempt))
        {
            return;
        }

        if (!await _sending.WaitAsync(force ? wait : Timeout.InfiniteTimeSpan).ConfigureAwait(false))
        {
            return;
        }

        try
        {
            ReportDrops();

            while (!_rejected)
            {
                List<ToolCallEvent> batch;
                lock (_gate)
                {
                    batch = _queue.Drain(_maxBatchSize);
                }

                if (batch.Count == 0)
                {
                    return;
                }

                try
                {
                    await _send(batch, CancellationToken.None).ConfigureAwait(false);
                }
                catch (Exception exception)
                {
                    Failed(batch, exception as TransportException
                        ?? new TransportException(exception.Message, null, true, TimeSpan.Zero));
                    return;
                }

                lock (_gate)
                {
                    _failures = 0;
                    _nextAttempt = DateTimeOffset.MinValue;
                }
            }
        }
        finally
        {
            _sending.Release();
        }
    }

    private void ReportDrops()
    {
        int dropped;
        lock (_gate)
        {
            dropped = _queue.Dropped - _reportedDrops;
            _reportedDrops = _queue.Dropped;
        }

        if (dropped > 0)
        {
            Log($"mcpspan: discarded {dropped} events, the queue was full");
        }
    }

    private void Failed(List<ToolCallEvent> batch, TransportException exception)
    {
        if (exception.Status is 401 or 403)
        {
            Reject(exception.Status.Value);
            return;
        }

        int failures;
        lock (_gate)
        {
            if (exception.Retryable)
            {
                _queue.Restore(batch);
            }

            failures = ++_failures;
            // The longer of our own backoff and what the API asked for.
            var wait = Backoff(failures, Random.Shared.NextDouble);
            _nextAttempt = DateTimeOffset.UtcNow + (exception.RetryAfter > wait ? exception.RetryAfter : wait);
        }

        if (!exception.Retryable)
        {
            // Refused the same way every time: dropped, and collecting goes on.
            Log($"mcpspan: dropped {batch.Count} events, rejected as {exception.Status}");
        }

        Log($"mcpspan: delivery failed ({exception.Message}), attempt {failures}");
    }

    /// <summary>
    /// Gives up on a key the endpoint refused, and says so once even with diagnostics off: a silent SDK collecting
    /// nothing because of a mistyped key is the worst way to spend an afternoon.
    /// </summary>
    private void Reject(int status)
    {
        if (_rejected)
        {
            return;
        }

        _rejected = true;
        lock (_gate)
        {
            _queue.Clear();
        }

        Warn($"mcpspan: the ingest endpoint rejected the API key (HTTP {status}). " +
             "Telemetry is now disabled for this process.");
    }

    private void Log(string message)
    {
        if (_debug)
        {
            Warn(message);
        }
    }

    /// <summary>
    /// The developer's callback if given, otherwise standard error. Never standard output: on the stdio transport
    /// it carries the MCP protocol, and a stray line there breaks the server.
    /// </summary>
    private void Warn(string message)
    {
        try
        {
            if (_onDiagnostic is not null)
            {
                _onDiagnostic(message);
                return;
            }

            Console.Error.WriteLine(message);
        }
        catch (Exception)
        {
            // Even reporting a problem must not become one.
        }
    }

    // The cancellation source is left to the collector: the delivery loop may still be finishing with it.
    public void Dispose() => _transport?.Dispose();
}
