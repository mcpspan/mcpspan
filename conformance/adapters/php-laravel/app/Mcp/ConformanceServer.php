<?php

declare(strict_types=1);

namespace App\Mcp;

use Laravel\Mcp\Server;
use Laravel\Mcp\Server\Attributes\Name;
use Laravel\Mcp\Server\Attributes\Version;

/**
 * The conformance adapter for the PHP SDK, on Laravel MCP, served by `php artisan mcp:start conformance`. Nothing
 * here mentions mcpspan: the package's service provider instruments the server as Laravel resolves it, with the key
 * from MCPSPAN_API_KEY and the rest from config/mcpspan.php.
 */
#[Name('conformance')]
#[Version('1.0.0')]
final class ConformanceServer extends Server
{
    protected string $version = '1.0.0';

    // Part of the server when Laravel resolves it, and so before it is instrumented.
    protected array $tools = [Early::class];

    // Resources and prompts (contract, 3.5): one resource at a fixed address, one read through a template, one that
    // throws; a prompt with a required argument, and one that throws.
    protected array $resources = [ConfigResource::class, TripResource::class, BrokenResource::class];

    protected array $prompts = [PlanTrip::class, BrokenPrompt::class];

    protected function boot(): void
    {
        // Added once the server is instrumented.
        array_push($this->tools, Ok::class, Large::class, ReportedError::class, Throws::class, Typed::class, Excluded::class, Long::class);
    }
}
