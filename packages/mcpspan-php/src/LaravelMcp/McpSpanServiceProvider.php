<?php

declare(strict_types=1);

namespace McpSpan\LaravelMcp;

use Illuminate\Support\ServiceProvider;
use Laravel\Mcp\Server;
use McpSpan\LaravelMcp;
use McpSpan\McpSpan;

/**
 * Instruments every Laravel MCP server the application resolves, local and web alike. Laravel discovers it when
 * the package is installed; the key comes from MCPSPAN_API_KEY, and without one nothing happens at all.
 */
final class McpSpanServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->mergeConfigFrom(__DIR__.'/../../config/mcpspan.php', 'mcpspan');
    }

    public function boot(): void
    {
        $this->publishes([__DIR__.'/../../config/mcpspan.php' => $this->app->configPath('mcpspan.php')], 'mcpspan-config');

        if (!class_exists(Server::class)) {
            return;
        }

        // Configured at the first MCP server, not as the application boots: a queue worker or a migration never
        // starts delivering. Settings given in code first are left as they are.
        $this->app->afterResolving(Server::class, function (Server $server): void {
            if (!McpSpan::collecting()) {
                /** @var array<string, mixed> $settings */
                $settings = array_filter((array) $this->app->make('config')->get('mcpspan', []), static fn (mixed $value): bool => null !== $value);
                McpSpan::configure($settings);
            }
            LaravelMcp::instrument($server);
        });
    }
}
