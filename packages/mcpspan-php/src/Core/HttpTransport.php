<?php

declare(strict_types=1);

namespace McpSpan\Core;

/**
 * Posts batches to the ingest API with PHP's own HTTP stream wrapper, so no extension is needed beyond OpenSSL for
 * HTTPS. It neither retries nor swallows: it answers null for a delivery, or a Failure.
 *
 * @internal
 */
final class HttpTransport
{
    public const TIMEOUT = 10;
    /** The longest Retry-After followed: a server asking for longer is wrong or unwell. */
    public const MAX_RETRY_AFTER = 300;

    private readonly string $url;

    public function __construct(string $endpoint, private readonly string $apiKey, private readonly string $version)
    {
        $this->url = rtrim($endpoint, '/').'/v1/events';
    }

    /** @param list<array<string, mixed>> $events */
    public function send(array $events): ?Failure
    {
        $context = stream_context_create(['http' => [
            'method' => 'POST',
            'header' => implode("\r\n", [
                'Content-Type: application/json',
                'Authorization: Bearer '.$this->apiKey,
                'User-Agent: mcpspan/'.$this->version.' (php)',
                'Connection: close',
            ]),
            'content' => Event::batch($events),
            'timeout' => self::TIMEOUT,
            // A redirected POST delivers nothing while looking like it did.
            'follow_location' => 0,
            'max_redirects' => 0,
            // Answers other than 2xx are read, not raised as warnings.
            'ignore_errors' => true,
        ]]);

        $body = @file_get_contents($this->url, false, $context);
        // PHP 8.4 added the function, and 8.5 deprecates the variable it replaces.
        $headers = \function_exists('http_get_last_response_headers')
            ? http_get_last_response_headers()
            // @phpstan-ignore nullCoalesce.variable (set by file_get_contents, or not at all when nothing answered)
            : $http_response_header ?? null;

        if (false === $body || !\is_array($headers) || [] === $headers) {
            $error = error_get_last()['message'] ?? 'no answer';

            // Unreachable, reset, timed out: the moment, not the batch.
            return new Failure("failed to reach {$this->url} ({$error})", null, true, 0.0);
        }

        $status = self::status($headers);
        if ($status >= 200 && $status < 300) {
            return null;
        }

        return new Failure(
            "ingest API answered {$status}",
            $status,
            408 === $status || 429 === $status || $status >= 500,
            self::retryAfter(self::header($headers, 'retry-after')),
        );
    }

    /** Retry-After in either form, whole seconds or an HTTP date. Zero leaves the SDK's own backoff to decide. */
    public static function retryAfter(?string $value, ?int $now = null): float
    {
        if (null === $value) {
            return 0.0;
        }
        $value = trim($value);
        if (ctype_digit($value)) {
            $wait = (float) $value;
        } else {
            $at = strtotime($value);
            $wait = false === $at ? 0.0 : (float) ($at - ($now ?? time()));
        }

        return max(0.0, min((float) self::MAX_RETRY_AFTER, $wait));
    }

    /** @param list<string> $headers */
    private static function status(array $headers): int
    {
        // After a redirect or a 100 Continue there is more than one status line; the last one answers.
        $status = 0;
        foreach ($headers as $line) {
            if (1 === preg_match('#^HTTP/\S+\s+(\d{3})#', $line, $match)) {
                $status = (int) $match[1];
            }
        }

        return $status;
    }

    /** @param list<string> $headers */
    private static function header(array $headers, string $name): ?string
    {
        foreach (array_reverse($headers) as $line) {
            if (str_starts_with(strtolower($line), $name.':')) {
                return trim(substr($line, \strlen($name) + 1));
            }
        }

        return null;
    }
}
