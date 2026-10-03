<?php

declare(strict_types=1);

namespace McpSpan\LaravelMcp;

use Laravel\Mcp\Server\Methods\GetPrompt as LaravelGetPrompt;
use Laravel\Mcp\Server\Prompt;
use Laravel\Mcp\Server\ServerContext;
use Laravel\Mcp\Transport\JsonRpcRequest;
use McpSpan\Core\Event;

/**
 * Answers `prompts/get` as Laravel MCP does, and records it under the prompt's name, its arguments as parameters.
 *
 * @internal
 */
final class GetPrompt extends LaravelGetPrompt
{
    use MeasuresPrimitive;

    private function describe(JsonRpcRequest $request, ServerContext $context): array
    {
        $name = $request->get('name');
        $name = \is_string($name) ? $name : '';
        $arguments = $request->params['arguments'] ?? null;
        $known = $context->prompts()->contains(static fn (mixed $prompt): bool => $prompt instanceof Prompt && $prompt->name() === $name);

        return [$name, \is_array($arguments) ? $arguments : null, $known];
    }

    private function kind(): string
    {
        return Event::KIND_PROMPT;
    }

    private function unknownSource(): string
    {
        return Event::SOURCE_UNKNOWN_PROMPT;
    }
}
