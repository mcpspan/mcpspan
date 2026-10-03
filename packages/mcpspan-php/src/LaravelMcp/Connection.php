<?php

declare(strict_types=1);

namespace McpSpan\LaravelMcp;

use Laravel\Mcp\Transport\JsonRpcRequest;
use McpSpan\Core\Event;
use McpSpan\LaravelMcp;

/**
 * Who a request came from, and on which connection, for tool calls, reads and prompt gets alike.
 *
 * @internal
 */
final class Connection
{
    private const CLIENT_INFO = 'io.modelcontextprotocol/clientInfo';

    private static ?string $stdioSession = null;

    /**
     * The client's name and version: from the request itself on 2026-07-28, else from the handshake of a stdio
     * connection.
     *
     * @return array{?string, ?string}
     */
    public static function client(JsonRpcRequest $request): array
    {
        $info = $request->meta()[self::CLIENT_INFO] ?? null;
        if (\is_array($info) && \is_string($info['name'] ?? null)) {
            return [$info['name'], \is_string($info['version'] ?? null) ? $info['version'] : null];
        }

        return $request->isLegacy() ? Initialize::client() : [null, null];
    }

    /**
     * One session per stdio process, on either protocol revision: the process is the connection. Laravel's HTTP
     * transport keeps no sessions, so requests over HTTP carry none.
     */
    public static function session(): ?string
    {
        if (!LaravelMcp::stdio()) {
            return null;
        }

        return self::$stdioSession ??= Event::uuid();
    }
}
