<?php

declare(strict_types=1);

namespace McpSpan\McpSdk;

use Mcp\Capability\Registry\ElementReference;
use Mcp\Capability\Registry\ReferenceHandler as SdkReferenceHandler;
use Mcp\Capability\Registry\ReferenceHandlerInterface;
use Mcp\Schema\JsonRpc\Request;
use Mcp\Server\Builder;
use Psr\Container\ContainerInterface;

/**
 * Runs tools, resources and prompts as the SDK's reference handler does, noting for the request being measured that
 * its handler was reached and what it threw. The SDK turns a handler's exception into an error that names no class;
 * this is where the class is still known.
 *
 * @internal
 */
final class ReferenceHandler implements ReferenceHandlerInterface
{
    /** @var \WeakMap<Request, CallState> */
    private static \WeakMap $calls;

    private ?ReferenceHandlerInterface $inner;

    public function __construct(private readonly Builder $builder)
    {
        self::$calls ??= new \WeakMap();
        $inner = Internals::read($builder, 'referenceHandler');
        $this->inner = $inner instanceof ReferenceHandlerInterface ? $inner : null;
    }

    public static function watch(Request $request, CallState $state): void
    {
        self::$calls ??= new \WeakMap();
        self::$calls[$request] = $state;
    }

    public function handle(ElementReference $reference, array $arguments): mixed
    {
        $request = $arguments['_request'] ?? null;
        $state = $request instanceof Request ? (self::$calls[$request] ?? null) : null;
        if (null !== $state) {
            $state->reached = true;
        }

        try {
            return $this->inner()->handle($reference, $arguments);
        } catch (\Throwable $e) {
            if (null !== $state) {
                $state->thrown = $e;
            }
            throw $e;
        }
    }

    /** The handler the builder had, or the one it would have made, with the container it has by now. */
    private function inner(): ReferenceHandlerInterface
    {
        if (null === $this->inner) {
            $container = Internals::read($this->builder, 'container');
            $this->inner = new SdkReferenceHandler($container instanceof ContainerInterface ? $container : null);
        }

        return $this->inner;
    }
}
