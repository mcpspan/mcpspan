<?php

declare(strict_types=1);

namespace McpSpan\Core;

/**
 * A delivery that did not succeed, and whether sending the same batch again could work.
 *
 * @internal
 */
final class Failure
{
    public function __construct(
        public readonly string $message,
        public readonly ?int $status,
        public readonly bool $retryable,
        public readonly float $retryAfter,
    ) {
    }
}
