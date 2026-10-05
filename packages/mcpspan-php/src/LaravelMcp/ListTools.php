<?php

declare(strict_types=1);

namespace McpSpan\LaravelMcp;

use Laravel\Mcp\Server\Methods\ListTools as LaravelListTools;
use Laravel\Mcp\Server\ServerContext;
use Laravel\Mcp\Transport\JsonRpcRequest;
use Laravel\Mcp\Transport\JsonRpcResponse;
use McpSpan\Core\Collector;
use McpSpan\Core\Definitions;

/**
 * Laravel MCP's `tools/list`, noting the tools it describes for the fingerprint each call carries (contract, 3.8).
 *
 * @internal
 */
final class ListTools extends LaravelListTools
{
    public function handle(JsonRpcRequest $request, ServerContext $context): JsonRpcResponse
    {
        $response = parent::handle($request, $context);
        if (Collector::collecting()) {
            Definitions::note($response->content['result']['tools'] ?? null);
        }

        return $response;
    }
}
