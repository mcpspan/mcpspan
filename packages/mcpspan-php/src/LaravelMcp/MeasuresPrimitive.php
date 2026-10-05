<?php

declare(strict_types=1);

namespace McpSpan\LaravelMcp;

use Illuminate\Validation\ValidationException;
use Laravel\Mcp\Server\ServerContext;
use Laravel\Mcp\Transport\JsonRpcRequest;
use Laravel\Mcp\Transport\JsonRpcResponse;
use McpSpan\Core\Call;
use McpSpan\Core\Collector;
use McpSpan\Core\Event;
use McpSpan\Core\Text;

/**
 * Answers `resources/read` or `prompts/get` as Laravel MCP does, and records how it went (contract, 3.5).
 *
 * Neither a resource nor a prompt has an error result of its own: one that answers is a success, one that throws is
 * an exception, and one the server does not have is refused before anything runs. A prompt checks its own arguments,
 * with `$request->validate()`, as a tool does, so a refused prompt is one that threw Laravel's ValidationException.
 *
 * @internal
 */
trait MeasuresPrimitive
{
    private ?\Throwable $thrown = null;

    /**
     * What is being asked for, as it is recorded: its name, and its parameters.
     *
     * @return array{string, ?array<array-key, mixed>, bool} the name, the parameters, and whether the server has it
     */
    abstract private function describe(JsonRpcRequest $request, ServerContext $context): array;

    abstract private function kind(): string;

    abstract private function unknownSource(): string;

    public function handle(JsonRpcRequest $request, ServerContext $context): \Generator|JsonRpcResponse
    {
        $this->thrown = null;
        $call = null;
        $known = false;
        try {
            if (Collector::collecting()) {
                [$name, $parameters, $known] = $this->describe($request, $context);
                $call = Collector::begin($name, $parameters, Connection::client($request), Connection::session(), $this->kind(), $context->implementation->version);
            }
        } catch (\Throwable) {
        }
        if (null === $call) {
            return parent::handle($request, $context);
        }

        try {
            $response = parent::handle($request, $context);
        } catch (\Throwable $e) {
            $this->settle($call, $known, $this->thrown ?? $e);
            throw $e;
        }
        if ($response instanceof \Generator) {
            return $this->streamed($response, $call, $known);
        }
        $this->settle($call, $known, $this->thrown, $response);

        return $response;
    }

    protected function callHandler(callable $handler, JsonRpcRequest $request): mixed
    {
        return parent::callHandler(function () use ($handler): mixed {
            try {
                return $handler();
            } catch (\Throwable $e) {
                $this->thrown = $e;
                throw $e;
            }
        }, $request);
    }

    protected function toJsonRpcStreamedResponse(JsonRpcRequest $request, iterable $responses, callable $serializable): \Generator
    {
        return parent::toJsonRpcStreamedResponse($request, $this->watching($responses), $serializable);
    }

    /**
     * @param iterable<mixed> $responses
     *
     * @return \Generator<mixed>
     */
    private function watching(iterable $responses): \Generator
    {
        try {
            yield from $responses;
        } catch (\Throwable $e) {
            $this->thrown = $e;
            throw $e;
        }
    }

    /**
     * Passes a streamed answer through, and records the request when its last message has gone.
     *
     * @param \Generator<JsonRpcResponse> $responses
     *
     * @return \Generator<JsonRpcResponse>
     */
    private function streamed(\Generator $responses, Call $call, bool $known): \Generator
    {
        $last = null;
        try {
            foreach ($responses as $key => $response) {
                $last = $response;
                yield $key => $response;
            }
        } catch (\Throwable $e) {
            $this->settle($call, $known, $this->thrown ?? $e);
            throw $e;
        }
        $this->settle($call, $known, $this->thrown, $last instanceof JsonRpcResponse ? $last : null);
    }

    private function settle(Call $call, bool $known, ?\Throwable $thrown, ?JsonRpcResponse $response = null): void
    {
        try {
            if (null === $thrown) {
                Collector::record($call, true, response: $response?->content['result'] ?? null);
            } elseif (!$known) {
                Collector::record($call, false, $this->unknownSource());
            } elseif ($thrown instanceof ValidationException && Event::KIND_PROMPT === $this->kind()) {
                Collector::record($call, false, Event::SOURCE_ARGUMENTS);
            } else {
                Collector::record($call, false, Event::SOURCE_EXCEPTION, Text::errorType($thrown), Text::truncate($thrown->getMessage(), Text::MAX_EXCEPTION_MESSAGE));
            }
        } catch (\Throwable) {
        }
    }
}
