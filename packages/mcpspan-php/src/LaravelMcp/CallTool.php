<?php

declare(strict_types=1);

namespace McpSpan\LaravelMcp;

use Illuminate\Validation\ValidationException;
use Laravel\Mcp\Server\Methods\CallTool as LaravelCallTool;
use Laravel\Mcp\Server\ServerContext;
use Laravel\Mcp\Server\Tool;
use Laravel\Mcp\Transport\JsonRpcRequest;
use Laravel\Mcp\Transport\JsonRpcResponse;
use McpSpan\Core\Call;
use McpSpan\Core\Collector;
use McpSpan\Core\Event;
use McpSpan\Core\Repeats;
use McpSpan\Core\Text;
use McpSpan\McpSpan;
use McpSpan\Measuring;

/**
 * Answers `tools/call` as Laravel MCP does, and records how it went.
 *
 * Laravel checks a tool's arguments inside the tool, with `$request->validate()`, so a refused call is one whose
 * tool threw Laravel's ValidationException: a type Laravel documents for exactly that, not a reading of its text.
 *
 * @internal
 */
final class CallTool extends LaravelCallTool
{
    public function handle(JsonRpcRequest $request, ServerContext $context): \Generator|JsonRpcResponse
    {
        $name = $request->params['name'] ?? null;
        if (!\is_string($name) || !Collector::collecting()) {
            return parent::handle($request, $context);
        }

        $tool = null;
        $call = null;
        try {
            $tool = $context->tools()->first(static fn ($candidate): bool => $candidate instanceof Tool && $candidate->name() === $name);
            if (!McpSpan::excluded($name, $tool instanceof Tool ? new \ReflectionClass($tool) : null)) {
                $call = Collector::begin($name, self::arguments($request), Connection::client($request), Connection::session(), null, $context->implementation->version);
                // Compared once, as the request arrives, before any validation (contract, 3.9).
                $call?->compareArguments(self::arguments($request), Repeats::continuesEarlierCall($request->params));
            }
        } catch (\Throwable) {
        }

        if (!$tool instanceof Tool) {
            try {
                return parent::handle($request, $context);
            } finally {
                if (null !== $call) {
                    Collector::record($call, false, Event::SOURCE_UNKNOWN_TOOL);
                }
            }
        }

        $invoker = new ToolInvoker();
        Measuring::enter();
        try {
            $response = $invoker->invoke($tool, $request);
        } catch (\Throwable $e) {
            if (null !== $call) {
                self::settle($call, null, $invoker->thrown ?? $e);
            }
            throw $e;
        } finally {
            Measuring::leave();
        }

        if (null === $call) {
            return $response;
        }
        if ($response instanceof \Generator) {
            return self::streamed($response, $call, $invoker);
        }
        self::settle($call, $response, $invoker->thrown);

        return $response;
    }

    /**
     * Passes a streamed answer through, and records the call when its last message has gone.
     *
     * @param \Generator<JsonRpcResponse> $responses
     *
     * @return \Generator<JsonRpcResponse>
     */
    private static function streamed(\Generator $responses, Call $call, ToolInvoker $invoker): \Generator
    {
        $last = null;
        try {
            foreach ($responses as $key => $response) {
                $last = $response;
                yield $key => $response;
            }
        } catch (\Throwable $e) {
            self::settle($call, null, $invoker->thrown ?? $e);
            throw $e;
        }
        self::settle($call, $last instanceof JsonRpcResponse ? $last : null, $invoker->thrown);
    }

    private static function settle(Call $call, ?JsonRpcResponse $response, ?\Throwable $thrown): void
    {
        try {
            $result = $response?->content['result'] ?? null;
            if (\is_array($result) && true !== ($result['isError'] ?? false)) {
                Collector::record($call, true, response: $result);

                return;
            }
            if ($thrown instanceof ValidationException) {
                Collector::record($call, false, Event::SOURCE_ARGUMENTS);

                return;
            }
            if (null !== $thrown) {
                Collector::record($call, false, Event::SOURCE_EXCEPTION, Text::errorType($thrown), Text::truncate($thrown->getMessage(), Text::MAX_EXCEPTION_MESSAGE));

                return;
            }
            Collector::record($call, false, Event::SOURCE_RESULT, null, self::text($result), $result);
        } catch (\Throwable) {
        }
    }

    /** @return array<array-key, mixed>|null */
    private static function arguments(JsonRpcRequest $request): ?array
    {
        $arguments = $request->params['arguments'] ?? null;

        return \is_array($arguments) ? $arguments : null;
    }

    private static function text(mixed $result): string
    {
        $texts = [];
        foreach (\is_array($result) ? ($result['content'] ?? []) : [] as $block) {
            if (\is_array($block) && 'text' === ($block['type'] ?? null) && \is_string($block['text'] ?? null)) {
                $texts[] = $block['text'];
            }
        }

        return Text::truncate(trim(implode(' ', $texts)), Text::MAX_RESULT_MESSAGE);
    }
}
