using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace McpSpan.Internal;

/// <summary>A delivery that did not succeed, and whether sending the same batch again could work.</summary>
internal sealed class TransportException(string message, int? status, bool retryable, TimeSpan retryAfter)
    : Exception(message)
{
    public int? Status { get; } = status;

    public bool Retryable { get; } = retryable;

    public TimeSpan RetryAfter { get; } = retryAfter;
}

/// <summary>Posts batches to the ingest API. It neither retries nor swallows.</summary>
internal sealed class Transport : IDisposable
{
    public static readonly TimeSpan Timeout = TimeSpan.FromSeconds(10);

    /// <summary>The longest Retry-After followed: a server asking for longer is wrong or unwell.</summary>
    public static readonly TimeSpan MaxRetryAfter = TimeSpan.FromMinutes(5);

    public static readonly string UserAgent = $"mcpspan/{Version.Current} (csharp)";

    private static readonly JsonSerializerOptions Json = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly HttpClient _client;
    private readonly Uri _url;
    private readonly string _apiKey;

    // No redirects: a redirected POST delivers nothing while looking like it did.
    public Transport(string endpoint, string apiKey)
        : this(endpoint, apiKey, new SocketsHttpHandler { AllowAutoRedirect = false })
    {
    }

    internal Transport(string endpoint, string apiKey, HttpMessageHandler handler)
    {
        _url = new Uri(endpoint.TrimEnd('/') + "/v1/events");
        _apiKey = apiKey;
        _client = new HttpClient(handler) { Timeout = Timeout };
    }

    public async Task SendAsync(IReadOnlyList<ToolCallEvent> events, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, _url)
        {
            Content = JsonContent.Create(new Batch(events), options: Json),
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _apiKey);
        request.Headers.TryAddWithoutValidation("User-Agent", UserAgent);

        HttpResponseMessage response;
        try
        {
            response = await _client.SendAsync(request, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is HttpRequestException or TaskCanceledException or IOException)
        {
            // Unreachable, reset, timed out: the moment, not the batch.
            throw new TransportException($"Failed to reach {_url} ({exception.Message})", null, true, TimeSpan.Zero);
        }

        using (response)
        {
            var status = (int)response.StatusCode;
            if (status is >= 200 and < 300)
            {
                return;
            }

            throw new TransportException(
                $"Ingest API answered {status}",
                status,
                status is 408 or 429 or >= 500,
                ReadRetryAfter(response.Headers.RetryAfter, DateTimeOffset.UtcNow));
        }
    }

    /// <summary>Retry-After in either form, seconds or a date. Zero leaves the SDK's own backoff to decide.</summary>
    public static TimeSpan ReadRetryAfter(RetryConditionHeaderValue? header, DateTimeOffset now)
    {
        var wait = header switch
        {
            { Delta: { } delta } => delta,
            { Date: { } date } => date - now,
            _ => TimeSpan.Zero,
        };

        return wait < TimeSpan.Zero ? TimeSpan.Zero : wait > MaxRetryAfter ? MaxRetryAfter : wait;
    }

    public void Dispose() => _client.Dispose();

    private sealed record Batch([property: JsonPropertyName("events")] IReadOnlyList<ToolCallEvent> Events);
}

/// <summary>The SDK's own version, reported with every event.</summary>
internal static class Version
{
    public const string Current = "0.2.0";
}
