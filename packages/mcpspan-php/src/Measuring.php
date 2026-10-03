<?php

declare(strict_types=1);

namespace McpSpan;

/**
 * Whether an instrumented server is measuring the call under way, so a tracked handler inside it counts nothing
 * twice. PHP runs one request at a time per process, save for fibers, which the MCP SDKs use to suspend a tool;
 * the flag belongs to the fiber that set it.
 *
 * @internal
 */
final class Measuring
{
    /** @var \WeakMap<object, int>|null */
    private static ?\WeakMap $fibers = null;
    private static int $main = 0;

    public static function enter(): void
    {
        $fiber = \Fiber::getCurrent();
        if (null === $fiber) {
            ++self::$main;

            return;
        }
        self::$fibers ??= new \WeakMap();
        self::$fibers[$fiber] = (self::$fibers[$fiber] ?? 0) + 1;
    }

    public static function leave(): void
    {
        $fiber = \Fiber::getCurrent();
        if (null === $fiber) {
            self::$main = max(0, self::$main - 1);

            return;
        }
        if (null !== self::$fibers && isset(self::$fibers[$fiber])) {
            self::$fibers[$fiber] = max(0, self::$fibers[$fiber] - 1);
        }
    }

    public static function active(): bool
    {
        $fiber = \Fiber::getCurrent();

        return null === $fiber ? self::$main > 0 : (self::$fibers[$fiber] ?? 0) > 0;
    }
}
