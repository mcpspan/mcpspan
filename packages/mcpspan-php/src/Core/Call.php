<?php

declare(strict_types=1);

namespace McpSpan\Core;

/**
 * What an integration knows about one call as it starts. A kind of null is a tool call.
 *
 * @internal
 */
final class Call
{
    /** @param array<string, string>|null $parameters */
    public function __construct(
        public readonly string $toolName,
        public readonly ?array $parameters,
        public readonly ?string $clientName,
        public readonly ?string $sessionId,
        public readonly int $started,
        public readonly float $timestamp,
        public readonly ?string $kind = null,
        public readonly ?string $clientVersion = null,
        /** The one the SDK was told, or else the one the server gives itself. */
        public readonly ?string $serverVersion = null,
    ) {
    }
}
