<?php

declare(strict_types=1);

namespace McpSpan\LaravelMcp;

use Laravel\Mcp\Server\Methods\ListTools as LaravelListTools;
use Laravel\Mcp\Server\ServerContext;
use Laravel\Mcp\Server\Tool;
use Laravel\Mcp\Transport\JsonRpcRequest;
use Laravel\Mcp\Transport\JsonRpcResponse;
use McpSpan\Core\Collector;
use McpSpan\Core\Definitions;
use McpSpan\Core\Event;
use McpSpan\McpSpan;

/**
 * Laravel MCP's `tools/list`, noting the tools it describes for the fingerprint each call carries (contract, 3.8), and
 * recording the answer (3.11).
 *
 * @internal
 */
final class ListTools extends LaravelListTools
{
    public function handle(JsonRpcRequest $request, ServerContext $context): JsonRpcResponse
    {
        $response = parent::handle($request, $context);
        if (Collector::collecting()) {
            $tools = Definitions::note($response->content['result']['tools'] ?? null);
            try {
                $call = Collector::begin('tools/list', null, Connection::client($request), Connection::session(), Event::KIND_LISTING, $context->implementation->version);
                Collector::recordListing($call, $tools, static function (string $name) use ($context): bool {
                    $tool = $context->tools()->first(static fn ($candidate): bool => $candidate instanceof Tool && $candidate->name() === $name);

                    return McpSpan::excluded($name, $tool instanceof Tool ? new \ReflectionClass($tool) : null);
                });
            } catch (\Throwable) {
            }
        }

        return $response;
    }
}
