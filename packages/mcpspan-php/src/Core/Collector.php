<?php

declare(strict_types=1);

namespace McpSpan\Core;

use McpSpan\McpSpan;

/**
 * The one configuration a process runs with, and recording calls under it.
 *
 * @internal
 */
final class Collector
{
    /**
     * Said when there is a key and nowhere to send: somebody meant to collect. There is no default endpoint, since
     * mcpspan runs wherever its user runs it, and a default would send their data somewhere they did not choose.
     */
    public const NO_ENDPOINT = 'mcpspan: an API key is set but no endpoint, so nothing is collected. Set MCPSPAN_ENDPOINT '
        .'(or the endpoint option) to your mcpspan installation, for example http://localhost:6271.';
    public const DEFAULT_FLUSH_INTERVAL = 5.0;
    public const DEFAULT_MAX_BATCH_SIZE = 100;
    public const DEFAULT_MAX_QUEUE_SIZE = 10_000;
    /** The API takes at most this many events in one request. */
    private const MAX_EVENTS_PER_REQUEST = 1_000;

    public const SETTINGS = [
        'apiKey', 'endpoint', 'captureParameterNames', 'serverVersion', 'debug', 'onDiagnostic', 'flushOnExit', 'flushInterval',
        'maxBatchSize', 'maxQueueSize',
    ];

    private static ?Delivery $delivery = null;
    /** @var array<string, mixed>|null */
    private static ?array $settings = null;
    private static bool $shutdownRegistered = false;
    /** @var \Closure(list<array<string, mixed>>): ?Failure|null */
    private static ?\Closure $sender = null;
    private static ?bool $longRunning = null;
    private static bool $saidNoEndpoint = false;

    /**
     * Starts collecting, or stops if there is no key to collect with. The same settings again change nothing.
     *
     * @param array<string, mixed> $settings
     */
    public static function configure(array $settings): void
    {
        $resolved = self::resolve($settings);
        if (null !== self::$delivery && null !== self::$settings && self::same(self::$settings, $resolved)) {
            return;
        }
        self::shutdown();

        // No key is a normal state, in development and CI, and not reported.
        if ('' === $resolved['apiKey']) {
            return;
        }

        // Said unasked, as a refused key is: without it the data goes nowhere and nothing tells anyone. A test's own
        // delivery stands in for the endpoint.
        if ('' === $resolved['endpoint'] && null === self::$sender) {
            if (!self::$saidNoEndpoint) {
                self::$saidNoEndpoint = true;
                try {
                    null !== $resolved['onDiagnostic'] ? ($resolved['onDiagnostic'])(self::NO_ENDPOINT) : error_log(self::NO_ENDPOINT);
                } catch (\Throwable) {
                }
            }

            return;
        }

        self::$settings = $resolved;
        self::$delivery = self::start($resolved);
        if (!self::$shutdownRegistered) {
            self::$shutdownRegistered = true;
            // Runs when the program ends on its own; a signal it does not handle stays the program's own business.
            register_shutdown_function(static function (): void {
                try {
                    if (null !== self::$delivery && (bool) (self::$settings['flushOnExit'] ?? true)) {
                        self::shutdown();
                    } elseif (null !== self::$delivery) {
                        self::$delivery->stop(false);
                    }
                } catch (\Throwable) {
                }
            });
        }
    }

    /**
     * @param array<string, mixed> $a
     * @param array<string, mixed> $b
     */
    private static function same(array $a, array $b): bool
    {
        // A callback is the same one, not one that looks alike.
        return $a['onDiagnostic'] === $b['onDiagnostic']
            && array_diff_key($a, ['onDiagnostic' => 0]) == array_diff_key($b, ['onDiagnostic' => 0]);
    }

    public static function shutdown(): void
    {
        $delivery = self::$delivery;
        self::$delivery = null;
        self::$settings = null;
        $delivery?->stop(true);
    }

    public static function collecting(): bool
    {
        return null !== self::$delivery;
    }

    /**
     * Notes the start of a call, or null when nothing is being recorded. The clock is read first. A server version
     * the SDK was told wins over the one the server gives itself.
     *
     * @param array<array-key, mixed>|null $arguments
     * @param array{?string, ?string}      $client    the client's name and version
     */
    public static function begin(string $toolName, ?array $arguments, array $client, ?string $sessionId, ?string $kind = null, ?string $serverVersion = null): ?Call
    {
        $started = hrtime(true);
        $timestamp = microtime(true);
        if (null === self::$delivery || null === self::$settings) {
            return null;
        }

        return new Call(
            $toolName,
            self::$settings['captureParameterNames'] ? Text::describeParameters($arguments) : null,
            $client[0],
            $sessionId,
            $started,
            $timestamp,
            $kind,
            $client[1],
            '' === self::$settings['serverVersion'] ? $serverVersion : self::$settings['serverVersion'],
        );
    }

    /** Builds the event for a finished call and queues it. It never blocks on the network. */
    /** The largest size an event carries; anything larger is sent as this (contract, 3.7). */
    public const MAX_RESPONSE_BYTES = 2147483647;

    /**
     * Size of an answer in bytes of its JSON, encoded as the MCP SDKs encode it, or null when there is none or it
     * cannot be encoded. The JSON is counted and dropped; nothing of it is kept or sent.
     */
    public static function responseBytes(mixed $response): ?int
    {
        if (null === $response) {
            return null;
        }
        try {
            return min(\strlen(json_encode($response, \JSON_THROW_ON_ERROR)), self::MAX_RESPONSE_BYTES);
        } catch (\Throwable) {
            return null;
        }
    }

    /**
     * Builds the event for a finished call and queues it. `$response` is the answer, when there was one, to be
     * measured (contract, 3.7).
     */
    public static function record(Call $call, bool $success, ?string $source = null, ?string $type = null, ?string $message = null, mixed $response = null): void
    {
        $duration = (hrtime(true) - $call->started) / 1e6;
        $delivery = self::$delivery;
        if (null === $delivery) {
            return;
        }
        try {
            $event = new Event(
                Event::uuid(),
                Text::truncate($call->toolName, Text::MAX_NAME),
                $duration,
                $success,
                $source,
                null === $type ? null : Text::truncate($type, Text::MAX_NAME),
                null === $message || '' === $message ? null : $message,
                Text::clientType($call->clientName),
                Text::clientName($call->clientName),
                self::timestamp($call->timestamp),
                $call->sessionId,
                $call->parameters,
                $call->kind,
                Text::version($call->clientVersion),
                Text::version($call->serverVersion),
                self::responseBytes($response),
                // A tool the server has, refused arguments included: often the schema is why.
                null === $call->kind && Event::SOURCE_UNKNOWN_TOOL !== $source ? Definitions::of($call->toolName) : null,
            );
            $delivery->record($event->toArray());
        } catch (\Throwable) {
        }
    }

    /**
     * For tests: deliver through this rather than over HTTP, from the server's own process.
     *
     * @param (\Closure(list<array<string, mixed>>): ?Failure)|null $sender
     */
    public static function useSender(?\Closure $sender): void
    {
        self::$sender = $sender;
    }

    /** For tests: forgets that the missing endpoint was already mentioned. */
    public static function forgetNoEndpointNotice(): void
    {
        self::$saidNoEndpoint = false;
    }

    /** For tests: whether to behave as a long-running server, whatever PHP_SAPI says. */
    public static function assumeLongRunning(?bool $longRunning): void
    {
        self::$longRunning = $longRunning;
    }

    /** @param array<string, mixed> $settings */
    private static function start(array $settings): Delivery
    {
        $say = self::say($settings);
        $longRunning = self::$longRunning ?? \PHP_SAPI === 'cli';

        if (null === self::$sender && $longRunning) {
            $worker = WorkerDelivery::start([
                'endpoint' => $settings['endpoint'],
                'apiKey' => $settings['apiKey'],
                'version' => McpSpan::VERSION,
                'flushInterval' => $settings['flushInterval'],
                'maxBatchSize' => $settings['maxBatchSize'],
                'maxQueueSize' => $settings['maxQueueSize'],
                'debug' => $settings['debug'],
                'diagnosticsToParent' => null !== $settings['onDiagnostic'],
            ], $settings['onDiagnostic'], $settings['maxQueueSize']);
            if (null !== $worker) {
                return $worker;
            }
            $say('mcpspan: could not start the delivery worker; delivering from the server process instead', false);
        }

        $transport = new HttpTransport($settings['endpoint'], $settings['apiKey'], McpSpan::VERSION);
        $reporter = new Reporter(
            $settings['endpoint'],
            self::$sender ?? $transport->send(...),
            $settings['flushInterval'],
            $settings['maxBatchSize'],
            $settings['maxQueueSize'],
            $say,
        );

        return new InlineDelivery($reporter, $longRunning);
    }

    /**
     * @param array<string, mixed> $settings
     *
     * @return \Closure(string, bool): void
     */
    private static function say(array $settings): \Closure
    {
        $debug = (bool) $settings['debug'];
        $callback = $settings['onDiagnostic'];

        return static function (string $message, bool $always) use ($debug, $callback): void {
            if (!$always && !$debug) {
                return;
            }
            try {
                if (null !== $callback) {
                    $callback($message);
                } else {
                    // Never standard output: on a stdio server it carries the MCP protocol.
                    error_log($message);
                }
            } catch (\Throwable) {
            }
        };
    }

    /**
     * @param array<string, mixed> $settings
     *
     * @return array<string, mixed>
     */
    public static function resolve(array $settings): array
    {
        $callback = $settings['onDiagnostic'] ?? null;
        $callback = \is_callable($callback) ? \Closure::fromCallable($callback) : null;
        $debug = (bool) ($settings['debug'] ?? false) || null !== $callback;
        $warn = static function (string $message) use ($debug, $callback): void {
            if ($debug) {
                null !== $callback ? $callback($message) : error_log($message);
            }
        };

        $unknown = array_diff(array_keys($settings), self::SETTINGS);
        if ([] !== $unknown) {
            $warn('mcpspan: ignoring unknown settings '.implode(', ', $unknown));
        }

        // A malformed setting falls back to its default, and says so when asked.
        $positive = static function (string $name, int|float $default, bool $whole) use ($settings, $warn): int|float {
            $value = $settings[$name] ?? null;
            if (null === $value) {
                return $default;
            }
            if (($whole ? \is_int($value) : (\is_int($value) || \is_float($value))) && $value > 0) {
                return $value;
            }
            $warn("mcpspan: ignoring {$name}=".var_export($value, true).', expected a positive number');

            return $default;
        };

        return [
            'apiKey' => self::firstSet($settings['apiKey'] ?? null, getenv('MCPSPAN_API_KEY')),
            'endpoint' => self::firstSet($settings['endpoint'] ?? null, getenv('MCPSPAN_ENDPOINT')),
            'captureParameterNames' => (bool) ($settings['captureParameterNames'] ?? false),
            'serverVersion' => self::firstSet($settings['serverVersion'] ?? null, getenv('MCPSPAN_SERVER_VERSION')),
            'debug' => $debug,
            'onDiagnostic' => $callback,
            'flushOnExit' => (bool) ($settings['flushOnExit'] ?? true),
            'flushInterval' => (float) $positive('flushInterval', self::DEFAULT_FLUSH_INTERVAL, false),
            'maxBatchSize' => min((int) $positive('maxBatchSize', self::DEFAULT_MAX_BATCH_SIZE, true), self::MAX_EVENTS_PER_REQUEST),
            'maxQueueSize' => (int) $positive('maxQueueSize', self::DEFAULT_MAX_QUEUE_SIZE, true),
        ];
    }

    private static function firstSet(mixed ...$values): string
    {
        foreach ($values as $value) {
            if (\is_string($value) && '' !== trim($value)) {
                return trim($value);
            }
        }

        return '';
    }

    private static function timestamp(float $seconds): string
    {
        $whole = (int) floor($seconds);
        $millis = (int) floor(($seconds - $whole) * 1000);

        return gmdate('Y-m-d\TH:i:s', $whole).\sprintf('.%03dZ', $millis);
    }
}
