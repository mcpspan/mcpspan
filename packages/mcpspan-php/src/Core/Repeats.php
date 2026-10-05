<?php

declare(strict_types=1);

namespace McpSpan\Core;

/**
 * Whether a call repeats the previous call to the same tool in the same session (contract, 3.9): an agent stuck in a
 * loop. Only the answer leaves the process. Kept here is a SHA-256 of the canonical arguments of the latest call per
 * session and tool, never sent: a digest of a short identifier or an enumerated value is found by trying every one.
 *
 * @internal
 */
final class Repeats
{
    /** Session and tool pairs kept, the oldest forgotten first. */
    public const MAX_KEPT = 10000;

    /** @var array<string, string> In insertion order: a pair noted again moves to the end. */
    private static array $latest = [];

    /**
     * Notes a call's arguments, as the client sent them, and says whether they are the previous call's to the same
     * tool in the same session. Arguments that cannot be written down are never a repeat. Never throws.
     */
    public static function note(string $sessionId, string $toolName, mixed $arguments): bool
    {
        try {
            $digest = hash('sha256', Definitions::canonicalText($arguments ?? new \stdClass()), true);
        } catch (\Throwable) {
            return false;
        }
        $key = $sessionId."\0".$toolName;
        $previous = self::$latest[$key] ?? null;
        unset(self::$latest[$key]);
        self::$latest[$key] = $digest;
        if (\count(self::$latest) > self::MAX_KEPT) {
            unset(self::$latest[array_key_first(self::$latest)]);
        }

        return $previous === $digest;
    }

    /**
     * Forgets a pair whose call ended asking the client for more (2026-07-28): the retry that answers continues that
     * call, and must not count as its repeat.
     */
    public static function interim(string $sessionId, string $toolName): void
    {
        unset(self::$latest[$sessionId."\0".$toolName]);
    }

    /** Whether request parameters answer an interim result's question, so the call continues an earlier one. */
    public static function continuesEarlierCall(mixed $params): bool
    {
        if (!\is_array($params)) {
            return false;
        }

        return \in_array(true, array_map(static fn (string $name): bool => isset($params[$name]) && '' !== $params[$name], ['inputResponses', 'requestState']), true);
    }

    /** For tests: forgets every call. */
    public static function forget(): void
    {
        self::$latest = [];
    }
}
