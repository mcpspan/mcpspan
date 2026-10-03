<?php

declare(strict_types=1);

namespace McpSpan\LaravelMcp;

use Laravel\Mcp\Server\Contracts\HasUriTemplate;
use Laravel\Mcp\Server\Methods\ReadResource as LaravelReadResource;
use Laravel\Mcp\Server\ServerContext;
use Laravel\Mcp\Transport\JsonRpcRequest;
use McpSpan\Core\Event;

/**
 * Answers `resources/read` as Laravel MCP does, and records it: a fixed resource by its URI, a templated one by its
 * template, never by the address the client sent, and an address with neither by its scheme alone.
 *
 * @internal
 */
final class ReadResource extends LaravelReadResource
{
    use MeasuresPrimitive;

    private function describe(JsonRpcRequest $request, ServerContext $context): array
    {
        $uri = $request->get('uri');
        $uri = \is_string($uri) ? $uri : '';
        try {
            // Laravel's own lookup, so what is recorded is what is read.
            $resource = $this->resolveResource($uri, $context);
        } catch (\InvalidArgumentException) {
            return [Event::scheme($uri), null, false];
        }
        if ($resource instanceof HasUriTemplate) {
            return [(string) $resource->uriTemplate(), $resource->uriTemplate()->match($uri) ?? [], true];
        }

        return [$resource->uri(), null, true];
    }

    private function kind(): string
    {
        return Event::KIND_RESOURCE;
    }

    private function unknownSource(): string
    {
        return Event::SOURCE_UNKNOWN_RESOURCE;
    }
}
