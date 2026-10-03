using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
using McpSpan.Internal;

namespace McpSpan.Tests;

public sealed class DeliveryTests
{
    /// <summary>Stands in for the ingest API: records each request and answers as scripted.</summary>
    private sealed class Ingest : HttpMessageHandler
    {
        public readonly List<(HttpRequestMessage Request, string Body)> Requests = [];
        public HttpStatusCode Status { get; set; } = HttpStatusCode.Accepted;
        public RetryConditionHeaderValue? RetryAfter { get; set; }

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Requests.Add((request, await request.Content!.ReadAsStringAsync(cancellationToken)));
            var response = new HttpResponseMessage(Status);
            response.Headers.RetryAfter = RetryAfter;
            return response;
        }
    }

    [Fact]
    public async Task Posts_JSON_with_the_key_and_a_User_Agent()
    {
        var ingest = new Ingest();
        using var transport = new Transport("https://ingest.example/", "k", ingest);

        await transport.SendAsync([QueueTests.Event(1)], CancellationToken.None);

        var (request, body) = Assert.Single(ingest.Requests);
        Assert.Equal("https://ingest.example/v1/events", request.RequestUri!.ToString());
        Assert.Equal("Bearer k", request.Headers.Authorization!.ToString());
        Assert.Equal($"mcpspan/{McpSpanSdk.Version} (csharp)", string.Join(" ", request.Headers.UserAgent));
        Assert.Equal("application/json", request.Content!.Headers.ContentType!.MediaType);
        using var parsed = JsonDocument.Parse(body);
        var sent = parsed.RootElement.GetProperty("events")[0];
        Assert.Equal("1", sent.GetProperty("id").GetString());
        // Absent fields are left out, not sent as null.
        Assert.False(sent.TryGetProperty("errorSource", out _));
    }

    [Fact]
    public async Task An_empty_batch_is_an_empty_list()
    {
        var ingest = new Ingest();
        using var transport = new Transport("https://ingest.example", "k", ingest);

        await transport.SendAsync([], CancellationToken.None);

        Assert.Equal("""{"events":[]}""", ingest.Requests[0].Body);
    }

    [Theory]
    [InlineData(408, true)]
    [InlineData(429, true)]
    [InlineData(500, true)]
    [InlineData(503, true)]
    [InlineData(400, false)]
    [InlineData(401, false)]
    [InlineData(413, false)]
    [InlineData(307, false)]
    public async Task Classifies_answers(int status, bool retryable)
    {
        using var transport = new Transport("https://ingest.example", "k", new Ingest { Status = (HttpStatusCode)status });

        var failure = await Assert.ThrowsAsync<TransportException>(() => transport.SendAsync([QueueTests.Event(1)], CancellationToken.None));

        Assert.Equal(status, failure.Status);
        Assert.Equal(retryable, failure.Retryable);
    }

    [Fact]
    public void Reads_Retry_After_in_both_forms_and_caps_it()
    {
        var now = new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);

        Assert.Equal(TimeSpan.FromSeconds(12), Transport.ReadRetryAfter(new RetryConditionHeaderValue(TimeSpan.FromSeconds(12)), now));
        Assert.Equal(TimeSpan.FromSeconds(30), Transport.ReadRetryAfter(new RetryConditionHeaderValue(now.AddSeconds(30)), now));
        Assert.Equal(Transport.MaxRetryAfter, Transport.ReadRetryAfter(new RetryConditionHeaderValue(TimeSpan.FromDays(1)), now));
        Assert.Equal(TimeSpan.Zero, Transport.ReadRetryAfter(null, now));
    }

    [Fact]
    public void Backoff_doubles_to_a_ceiling_within_the_spread()
    {
        Assert.Equal(TimeSpan.FromMilliseconds(500), Reporter.Backoff(1, () => 0));
        Assert.Equal(TimeSpan.FromSeconds(1), Reporter.Backoff(1, () => 1));
        Assert.Equal(TimeSpan.FromSeconds(4), Reporter.Backoff(3, () => 1));
        Assert.Equal(TimeSpan.FromMinutes(1), Reporter.Backoff(30, () => 1));
    }

    /// <summary>Records batches and answers from a script, then with success.</summary>
    private sealed class Script(params Exception?[] answers)
    {
        private readonly Queue<Exception?> _answers = new(answers);
        public readonly List<(DateTimeOffset At, string[] Ids)> Batches = [];

        public Task Send(IReadOnlyList<ToolCallEvent> batch, CancellationToken _)
        {
            lock (Batches)
            {
                Batches.Add((DateTimeOffset.UtcNow, [.. batch.Select(e => e.Id)]));
                if (_answers.TryDequeue(out var answer) && answer is not null)
                {
                    throw answer;
                }
            }

            return Task.CompletedTask;
        }

        public string[][] WithEvents()
        {
            lock (Batches)
            {
                return [.. Batches.Where(b => b.Ids.Length > 0).Select(b => b.Ids)];
            }
        }

        public int Count
        {
            get
            {
                lock (Batches)
                {
                    return Batches.Count;
                }
            }
        }
    }

    private static Reporter NewReporter(Script script, TimeSpan? interval = null, int batch = 100, int queue = 10_000,
        bool debug = false, Action<string>? notes = null) =>
        new("https://ingest.example", interval ?? TimeSpan.FromMilliseconds(20), batch, queue, debug, notes, script.Send);

    private static async Task Eventually(Func<bool> condition)
    {
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (!condition())
        {
            Assert.True(DateTime.UtcNow < deadline, "timed out");
            await Task.Delay(5, TestContext.Current.CancellationToken);
        }
    }

    private static readonly TimeSpan Stop = TimeSpan.FromSeconds(5);

    [Fact]
    public async Task Announces_once_with_an_empty_batch()
    {
        var script = new Script();
        var reporter = NewReporter(script);
        reporter.Start();

        await Eventually(() => script.Count == 1);
        await Task.Delay(100, TestContext.Current.CancellationToken);
        await reporter.StopAsync(Stop);

        Assert.Single(script.Batches);
        Assert.Empty(script.Batches[0].Ids);
    }

    [Fact]
    public async Task Delivers_on_the_interval_and_a_full_batch_at_once()
    {
        var script = new Script();
        var reporter = NewReporter(script, interval: TimeSpan.FromHours(1), batch: 2);
        reporter.Start();

        reporter.Record(QueueTests.Event(1));
        reporter.Record(QueueTests.Event(2));

        await Eventually(() => script.WithEvents().Length == 1);
        Assert.Equal(["1", "2"], script.WithEvents()[0]);
        await reporter.StopAsync(Stop);
    }

    [Theory]
    [InlineData(401)]
    [InlineData(403)]
    public async Task A_refused_key_stops_for_good_and_says_so_unasked(int status)
    {
        var notes = new System.Collections.Concurrent.ConcurrentQueue<string>();
        var script = new Script(new TransportException("no", status, false, TimeSpan.Zero));
        var reporter = NewReporter(script, notes: notes.Enqueue);
        reporter.Start();
        // Until the refusal is handled, not only sent: the key is given up on once it has been answered.
        await Eventually(() => !notes.IsEmpty);

        reporter.Record(QueueTests.Event(1));
        await reporter.StopAsync(Stop);

        Assert.Equal(1, script.Count);
        Assert.Contains($"HTTP {status}", Assert.Single(notes), StringComparison.Ordinal);
    }

    [Fact]
    public async Task Keeps_a_batch_through_a_passing_failure_and_waits_as_asked()
    {
        var script = new Script(null, new TransportException("busy", 429, true, TimeSpan.FromMilliseconds(1500)));
        var reporter = NewReporter(script);
        reporter.Start();

        reporter.Record(QueueTests.Event(1));
        await Eventually(() => script.WithEvents().Length == 2);
        await reporter.StopAsync(Stop);

        var times = script.Batches.Where(b => b.Ids.Length > 0).Select(b => b.At).ToArray();
        Assert.True(times[1] - times[0] >= TimeSpan.FromMilliseconds(1450));
        Assert.Equal(script.WithEvents()[0], script.WithEvents()[1]);
    }

    [Fact]
    public async Task Drops_a_malformed_batch_and_keeps_collecting()
    {
        var script = new Script(null, new TransportException("bad", 400, false, TimeSpan.Zero));
        var reporter = NewReporter(script);
        reporter.Start();

        reporter.Record(QueueTests.Event(1));
        await Eventually(() => script.WithEvents().Length == 1);
        await Task.Delay(1100, TestContext.Current.CancellationToken);
        reporter.Record(QueueTests.Event(2));
        await Eventually(() => script.WithEvents().Length == 2);
        await reporter.StopAsync(Stop);

        Assert.Equal(["2"], script.WithEvents()[1]);
    }

    [Fact]
    public async Task Stop_delivers_what_is_queued_despite_a_delay()
    {
        var script = new Script(null, new TransportException("down", 500, true, TimeSpan.Zero));
        var reporter = NewReporter(script, interval: TimeSpan.FromHours(1), batch: 1);
        reporter.Start();

        reporter.Record(QueueTests.Event(1));
        await Eventually(() => script.WithEvents().Length == 1);
        reporter.Record(QueueTests.Event(2));
        await reporter.StopAsync(Stop);

        Assert.Equal([["1"], ["1"], ["2"]], script.WithEvents());
    }

    [Fact]
    public async Task Reports_discarded_events_only_when_asked()
    {
        var notes = new List<string>();
        var script = new Script();
        var reporter = NewReporter(script, interval: TimeSpan.FromHours(1), queue: 2, debug: true, notes: notes.Add);

        for (var i = 0; i < 5; i++)
        {
            reporter.Record(QueueTests.Event(i));
        }

        await reporter.StopAsync(Stop);

        Assert.Equal([["3", "4"]], script.WithEvents());
        Assert.Contains("discarded 3 events", notes[0], StringComparison.Ordinal);
    }
}
