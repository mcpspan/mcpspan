<?php

declare(strict_types=1);

namespace McpSpan\Core;

/**
 * Where recorded events go from the server's own process.
 *
 * @internal
 */
interface Delivery
{
    /** @param array<string, mixed> $event */
    public function record(array $event): void;

    /** Delivers what is queued and stops. Final, it is the last chance these events get. */
    public function stop(bool $final): void;
}
