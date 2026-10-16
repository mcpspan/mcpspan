<?php

declare(strict_types=1);

namespace McpSpan\Core;

/**
 * The listings already sent for each session, so the same answer to `tools/list` is sent once per session
 * (contract, 3.11). A client lists the tools at the start of a session and often again; the count that matters is the
 * sessions that were shown the tools, not how often they asked.
 *
 * @internal
 */
final class Listings
{
    /** Sessions kept, the oldest forgotten first. */
    private const MAX_SESSIONS = 10000;

    /** @var array<string, array<string, true>> */
    private static array $sent = [];

    /** Whether a listing is new for its session, noting it as sent. A listing with no session always is. */
    public static function first(?string $sessionId, string $signature): bool
    {
        if (null === $sessionId) {
            return true;
        }
        $signatures = self::$sent[$sessionId] ?? [];
        unset(self::$sent[$sessionId]);
        $new = !isset($signatures[$signature]);
        $signatures[$signature] = true;
        self::$sent[$sessionId] = $signatures;
        if (\count(self::$sent) > self::MAX_SESSIONS) {
            unset(self::$sent[array_key_first(self::$sent)]);
        }

        return $new;
    }

    /** For tests: forgets every listing sent. */
    public static function forget(): void
    {
        self::$sent = [];
    }
}
