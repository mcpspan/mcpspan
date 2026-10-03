<?php

declare(strict_types=1);

namespace McpSpan\LaravelMcp;

use Laravel\Mcp\Server\Methods\Initialize as LaravelInitialize;
use Laravel\Mcp\Server\ServerContext;
use Laravel\Mcp\Transport\JsonRpcRequest;
use Laravel\Mcp\Transport\JsonRpcResponse;
use McpSpan\LaravelMcp;

/**
 * Answers `initialize` as Laravel MCP does, and remembers who asked, for a stdio server: there the process is the
 * connection. Over HTTP each request builds its own server, and the handshake is another request's, so the client
 * stays unknown there, as the contract requires.
 *
 * @internal
 */
final class Initialize extends LaravelInitialize
{
    /** @var array{?string, ?string} */
    private static array $client = [null, null];

    public function handle(JsonRpcRequest $request, ServerContext $context): JsonRpcResponse
    {
        if (LaravelMcp::stdio()) {
            $name = $request->params['clientInfo']['name'] ?? null;
            $version = $request->params['clientInfo']['version'] ?? null;
            self::$client = [\is_string($name) ? $name : null, \is_string($version) ? $version : null];
        }

        return parent::handle($request, $context);
    }

    /** @return array{?string, ?string} the name and version of the client that connected */
    public static function client(): array
    {
        return LaravelMcp::stdio() ? self::$client : [null, null];
    }
}
