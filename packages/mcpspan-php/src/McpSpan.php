<?php

declare(strict_types=1);

namespace McpSpan;

use McpSpan\Core\Collector;
use McpSpan\Core\Event;
use McpSpan\Core\Text;

/**
 * Analytics for MCP servers: which tools are called, by which client, how long they take, and which ones fail.
 *
 * Instrumenting a server is one line, in the class for the MCP SDK it is built on: {@see McpSdk} for the official
 * PHP MCP SDK, and {@see LaravelMcp} for Laravel MCP, which needs no line at all. Without an API key nothing is
 * collected and nothing is sent. Parameter values never leave the process.
 *
 * Settings: `apiKey` (else MCPSPAN_API_KEY), `endpoint`, your mcpspan installation (else MCPSPAN_ENDPOINT; no
 * default, and nothing is collected without it), `captureParameterNames`, `debug`, `onDiagnostic`, `flushOnExit`, `flushInterval` (seconds),
 * `maxBatchSize`, `maxQueueSize`. Nothing here throws over a setting.
 */
final class McpSpan
{
    /** The SDK's own version, reported with every event. */
    public const VERSION = '0.2.0';

    /** @var array<string, true> */
    private static array $excluded = [];

    /**
     * Starts collecting, or stops if there is no key to collect with. Configuring again with the same settings
     * changes nothing, so code that runs per request can call it every time; different settings replace the running
     * configuration, delivering what it held.
     *
     * @param array<string, mixed> $settings
     */
    public static function configure(array $settings = []): void
    {
        try {
            Collector::configure($settings);
        } catch (\Throwable $e) {
            if ((bool) ($settings['debug'] ?? false)) {
                error_log('mcpspan: could not configure ('.$e->getMessage().')');
            }
        }
    }

    /**
     * Stops collecting and delivers what is queued, ignoring any wait for a retry: it is the last chance these
     * events get. What is queued is also delivered as the program ends, so most servers need not call this.
     */
    public static function shutdown(): void
    {
        try {
            Collector::shutdown();
        } catch (\Throwable) {
        }
    }

    /** Whether an API key is configured and calls are being recorded. */
    public static function collecting(): bool
    {
        return Collector::collecting();
    }

    /**
     * Leaves a tool out by name, for a tool with no class or method of its own to mark with {@see Exclude}.
     * Returns the name, so it can be used where the tool is named.
     */
    public static function exclude(string $name): string
    {
        self::$excluded[$name] = true;

        return $name;
    }

    /** @internal */
    public static function excluded(string $name, ?\Reflector $handler = null): bool
    {
        if (isset(self::$excluded[$name])) {
            return true;
        }
        if ($handler instanceof \ReflectionMethod) {
            return [] !== $handler->getAttributes(Exclude::class)
                || [] !== $handler->getDeclaringClass()->getAttributes(Exclude::class);
        }
        if ($handler instanceof \ReflectionFunctionAbstract || $handler instanceof \ReflectionClass) {
            return [] !== $handler->getAttributes(Exclude::class);
        }

        return false;
    }

    /** @internal For tests. */
    public static function forgetExclusions(): void
    {
        self::$excluded = [];
    }

    /**
     * Measures one tool handler, for a server no integration covers. Returns a handler that takes and returns what
     * the given one does. Recorded by hand, a call cannot see its connection or its client, and records neither.
     *
     * @template T
     *
     * @param callable(mixed ...): T $handler
     *
     * @return \Closure(mixed ...): T
     */
    public static function track(string $name, callable $handler): \Closure
    {
        return static function (mixed ...$arguments) use ($name, $handler): mixed {
            if (!Collector::collecting() || self::excluded($name) || Measuring::active()) {
                return $handler(...$arguments);
            }
            $call = Collector::begin($name, $arguments, [null, null], null);
            try {
                $result = $handler(...$arguments);
            } catch (\Throwable $e) {
                if (null !== $call) {
                    Collector::record($call, false, Event::SOURCE_EXCEPTION, Text::errorType($e), Text::truncate($e->getMessage(), Text::MAX_EXCEPTION_MESSAGE));
                }
                throw $e;
            }
            if (null !== $call) {
                Collector::record($call, true, response: $result);
            }

            return $result;
        };
    }
}
