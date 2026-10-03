<?php

declare(strict_types=1);

namespace McpSpan;

use Mcp\Server\Builder;
use McpSpan\Core\Collector;
use McpSpan\McpSdk\CallToolHandler;
use McpSpan\McpSdk\Connections;
use McpSpan\McpSdk\PrimitiveHandler;
use McpSpan\McpSdk\ReferenceHandler;

/**
 * Measures the tools, resource reads and prompt gets of a server built on the official PHP MCP SDK, `mcp/sdk`.
 *
 *     $server = McpSdk::instrument(Server::builder(), ['apiKey' => getenv('MCPSPAN_API_KEY')])
 *         ->setServerInfo('flights', '1.0.0')
 *         ->addTool(new SearchFlights(), 'search_flights')
 *         ->build();
 *
 * It works through the builder's own extension points: `tools/call`, `resources/read` and `prompts/get` handlers,
 * which the SDK consults before its own and which hand every request on to those, and a reference handler around the
 * SDK's, which shows whether a request reached its handler and what the handler threw.
 */
final class McpSdk
{
    /** @var \WeakMap<Builder, true>|null */
    private static ?\WeakMap $instrumented = null;

    /**
     * Instruments a server as it is built. Every tool is measured, whether it was added before this call or after,
     * or registered once the server runs. Call it before build(), and after any setReferenceHandler() of your own.
     *
     * @param array<string, mixed> $settings the settings of {@see McpSpan::configure()}; without them, the
     *                                       environment, unless already configured
     */
    public static function instrument(Builder $builder, array $settings = []): Builder
    {
        try {
            if ([] !== $settings) {
                McpSpan::configure($settings);
            } elseif (!Collector::collecting()) {
                McpSpan::configure();
            }

            self::$instrumented ??= new \WeakMap();
            if (isset(self::$instrumented[$builder])) {
                return $builder;
            }
            self::$instrumented[$builder] = true;

            $connections = new Connections();
            $builder->setReferenceHandler(new ReferenceHandler($builder));
            $builder->addRequestHandler(new CallToolHandler($builder, $connections));
            $builder->addRequestHandler(new PrimitiveHandler($builder, $connections));
        } catch (\Throwable) {
        }

        return $builder;
    }
}
