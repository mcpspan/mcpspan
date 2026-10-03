<?php

declare(strict_types=1);

namespace McpSpan;

use Laravel\Mcp\Server;
use Laravel\Mcp\Server\Transport\StdioTransport;
use McpSpan\Core\Collector;
use McpSpan\LaravelMcp\CallTool;
use McpSpan\LaravelMcp\GetPrompt;
use McpSpan\LaravelMcp\Initialize;
use McpSpan\LaravelMcp\ReadResource;

/**
 * Measures the tools, resource reads and prompt gets of a Laravel MCP server, `laravel/mcp`.
 *
 * Installing the package is enough: its service provider instruments every MCP server the application resolves,
 * with the key from MCPSPAN_API_KEY. This is for a server built by hand, or settings given in code.
 *
 * It swaps the server's `tools/call`, `resources/read` and `prompts/get` methods, through the server's own
 * addMethod(), for ones that answer the same way and record how each request went.
 */
final class LaravelMcp
{
    /** Whether this process serves MCP over stdio, where one process is one connection. */
    private static bool $stdio = false;

    /**
     * @param array<string, mixed> $settings the settings of {@see McpSpan::configure()}; without them, the
     *                                       environment, unless already configured
     */
    public static function instrument(Server $server, array $settings = []): Server
    {
        try {
            if ([] !== $settings) {
                McpSpan::configure($settings);
            } elseif (!Collector::collecting()) {
                McpSpan::configure();
            }

            $transport = (new \ReflectionProperty(Server::class, 'transport'))->getValue($server);
            if ($transport instanceof StdioTransport) {
                self::$stdio = true;
            }

            $server->addMethod('tools/call', CallTool::class);
            $server->addMethod('resources/read', ReadResource::class);
            $server->addMethod('prompts/get', GetPrompt::class);
            $server->addMethod('initialize', Initialize::class);
        } catch (\Throwable) {
        }

        return $server;
    }

    /** @internal For tests. */
    public static function forget(): void
    {
        self::$stdio = false;
    }

    /** @internal */
    public static function stdio(): bool
    {
        return self::$stdio;
    }
}
