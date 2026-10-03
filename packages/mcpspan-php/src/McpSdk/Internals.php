<?php

declare(strict_types=1);

namespace McpSpan\McpSdk;

use Mcp\Server\Builder;

/**
 * The two private parts of the builder the integration reads, and nothing else: the reference handler it was
 * given, to wrap it, and the parts it assembled, to find the SDK's own `tools/call` handler and registry. If a
 * version of the SDK moves them, instrumenting finds nothing and the server runs as it would have;
 * tests/McpSdkTest.php fails first.
 *
 * @internal
 */
final class Internals
{
    public static function read(Builder $builder, string $property): mixed
    {
        try {
            $reflection = new \ReflectionProperty(Builder::class, $property);

            return $reflection->isInitialized($builder) ? $reflection->getValue($builder) : null;
        } catch (\ReflectionException) {
            return null;
        }
    }

    /** @return array<string, mixed>|null */
    public static function parts(Builder $builder): ?array
    {
        $parts = self::read($builder, 'parts');

        return \is_array($parts) ? $parts : null;
    }
}
