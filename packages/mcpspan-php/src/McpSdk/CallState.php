<?php

declare(strict_types=1);

namespace McpSpan\McpSdk;

/**
 * What the reference handler saw of the call being measured.
 *
 * @internal
 */
final class CallState
{
    public bool $reached = false;
    public ?\Throwable $thrown = null;
}
