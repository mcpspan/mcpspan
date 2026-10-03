<?php

declare(strict_types=1);

namespace McpSpan;

/**
 * Leaves a tool out: its calls, refused ones included, are not recorded. Put it on the tool's class, method or
 * function, so a rename carries it along.
 *
 * For tools called by machinery rather than by an agent. A health check polled every few seconds outnumbers
 * everything a person does and drags the whole server's error rate and response time towards its own.
 */
#[\Attribute(\Attribute::TARGET_CLASS | \Attribute::TARGET_METHOD | \Attribute::TARGET_FUNCTION)]
final class Exclude
{
}
