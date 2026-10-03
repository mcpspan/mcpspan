package com.mcpspan.internal;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.List;
import java.util.Optional;

/** Posts batches to the ingest API. It neither retries nor swallows. Internal: not part of the package's API. */
final class Transport implements Sender {

    static final Duration TIMEOUT = Duration.ofSeconds(10);

    /** The longest Retry-After followed: a server asking for longer is wrong or unwell. */
    static final Duration MAX_RETRY_AFTER = Duration.ofMinutes(5);

    static final String USER_AGENT = "mcpspan/" + Version.CURRENT + " (java)";

    private final URI url;
    private final String apiKey;

    // No redirects: a redirected POST delivers nothing while looking like it did.
    private final HttpClient client = HttpClient.newBuilder()
        .followRedirects(HttpClient.Redirect.NEVER)
        .connectTimeout(TIMEOUT)
        .build();

    Transport(String endpoint, String apiKey) {
        this.url = URI.create(endpoint.replaceAll("/+$", "") + "/v1/events");
        this.apiKey = apiKey;
    }

    static String body(List<ToolCallEvent> events) {
        StringBuilder json = new StringBuilder("{\"events\":[");
        for (int i = 0; i < events.size(); i++) {
            if (i > 0) {
                json.append(',');
            }
            events.get(i).writeTo(json);
        }
        return json.append("]}").toString();
    }

    @Override
    public void send(List<ToolCallEvent> events) throws TransportException {
        HttpRequest request = HttpRequest.newBuilder(url)
            .timeout(TIMEOUT)
            .header("Content-Type", "application/json")
            .header("Authorization", "Bearer " + apiKey)
            .header("User-Agent", USER_AGENT)
            .POST(HttpRequest.BodyPublishers.ofString(body(events)))
            .build();

        HttpResponse<Void> response;
        try {
            response = client.send(request, HttpResponse.BodyHandlers.discarding());
        }
        catch (IOException e) {
            // Unreachable, reset, timed out: the moment, not the batch.
            throw new TransportException("Failed to reach " + url + " (" + e + ")", -1, true, Duration.ZERO);
        }
        catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new TransportException("Interrupted delivering to " + url, -1, true, Duration.ZERO);
        }

        int status = response.statusCode();
        if (status >= 200 && status < 300) {
            return;
        }
        throw new TransportException("Ingest API answered " + status, status,
            status == 408 || status == 429 || status >= 500,
            retryAfter(response.headers().firstValue("Retry-After"), ZonedDateTime.now()));
    }

    /** Retry-After in either form, whole seconds or a date. Zero leaves the SDK's own backoff to decide. */
    static Duration retryAfter(Optional<String> header, ZonedDateTime now) {
        if (header.isEmpty() || header.get().isBlank()) {
            return Duration.ZERO;
        }
        String value = header.get().trim();
        Duration wait;
        try {
            wait = value.chars().allMatch(Character::isDigit)
                ? Duration.ofSeconds(Long.parseLong(value))
                : Duration.between(now, ZonedDateTime.parse(value, DateTimeFormatter.RFC_1123_DATE_TIME));
        }
        catch (NumberFormatException | DateTimeParseException e) {
            return Duration.ZERO;
        }
        if (wait.isNegative()) {
            return Duration.ZERO;
        }
        return wait.compareTo(MAX_RETRY_AFTER) > 0 ? MAX_RETRY_AFTER : wait;
    }
}
