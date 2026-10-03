<?php

declare(strict_types=1);

// The conformance adapter for the PHP SDK, on the official PHP MCP SDK: an MCP server over stdio with the tools the
// suite calls.

require __DIR__.'/vendor/autoload.php';

use Mcp\Schema\Content\TextContent;
use Mcp\Schema\Result\CallToolResult;
use Mcp\Server;
use Mcp\Server\Transport\StdioTransport;
use McpSpan\Exclude;
use McpSpan\McpSdk;

final class ConformanceError extends \RuntimeException
{
}

final class Excluded
{
    #[Exclude]
    public function __invoke(?float $depth = null): string
    {
        return 'ok';
    }
}

$builder = Server::builder()
    ->setServerInfo('conformance', '1.0.0')
    // Added before the server is instrumented, as the contract requires an SDK to measure too.
    ->addTool(static fn (): string => 'ok', 'early');

McpSdk::instrument($builder, [
    'flushInterval' => ((int) (getenv('CONFORMANCE_FLUSH_MS') ?: 200)) / 1000,
    'captureParameterNames' => '1' === getenv('CONFORMANCE_CAPTURE_PARAMETERS'),
]);

$builder
    ->addTool(static fn (): string => 'ok', 'ok')
    ->addTool(static fn (): CallToolResult => CallToolResult::error([new TextContent('No flights found')]), 'reported_error')
    ->addTool(static function (): string {
        throw new ConformanceError('boom');
    }, 'throws')
    ->addTool(static fn (string $destination, float $passengers): string => 'ok', 'typed')
    ->addTool(Excluded::class, 'excluded')
    ->addTool(static fn (): string => 'ok', 'long_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');

// Resources and prompts (contract, 3.5): one resource at a fixed address, one read through a template, one that
// throws; a prompt with a required argument, and one that throws.
$builder
    ->addResource(static fn (): string => 'ok', 'config://app', 'config')
    ->addResourceTemplate(static fn (string $id): string => 'ok', 'trips://{id}', 'trip')
    ->addResource(static function (): string {
        throw new ConformanceError('boom');
    }, 'broken://status', 'broken')
    ->addPrompt(static fn (string $destination): array => [['role' => 'user', 'content' => "Plan a trip to {$destination}"]], 'plan_trip')
    ->addPrompt(static function (): array {
        throw new ConformanceError('boom');
    }, 'broken_prompt');

$builder->build()->run(new StdioTransport());
