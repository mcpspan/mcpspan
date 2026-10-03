<?php

declare(strict_types=1);

namespace McpSpan\LaravelMcp;

use Laravel\Mcp\Server\ToolInvoker as LaravelToolInvoker;
use Laravel\Mcp\Transport\JsonRpcRequest;

/**
 * Invokes a tool as Laravel MCP does, noting what it threw before Laravel turns it into an error result. Laravel
 * keeps the exception to itself; its class is only known here.
 *
 * @internal
 */
final class ToolInvoker extends LaravelToolInvoker
{
    public ?\Throwable $thrown = null;

    protected function callHandler(callable $handler, JsonRpcRequest $request): mixed
    {
        return parent::callHandler(function () use ($handler): mixed {
            try {
                return $handler();
            } catch (\Throwable $e) {
                $this->thrown = $e;
                throw $e;
            }
        }, $request);
    }

    protected function toJsonRpcStreamedResponse(JsonRpcRequest $request, iterable $responses, callable $serializable): \Generator
    {
        return parent::toJsonRpcStreamedResponse($request, $this->watching($responses), $serializable);
    }

    /**
     * @param iterable<mixed> $responses
     *
     * @return \Generator<mixed>
     */
    private function watching(iterable $responses): \Generator
    {
        try {
            yield from $responses;
        } catch (\Throwable $e) {
            $this->thrown = $e;
            throw $e;
        }
    }
}
