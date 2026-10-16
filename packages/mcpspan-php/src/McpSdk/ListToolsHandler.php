<?php

declare(strict_types=1);

namespace McpSpan\McpSdk;

use Mcp\Capability\RegistryInterface;
use Mcp\Schema\JsonRpc\Error;
use Mcp\Schema\JsonRpc\Request;
use Mcp\Schema\JsonRpc\Response;
use Mcp\Schema\Request\ListToolsRequest;
use Mcp\Schema\Result\ListToolsResult;
use Mcp\Server\Builder;
use Mcp\Server\Handler\Request\RequestHandlerInterface;
use Mcp\Server\Session\SessionInterface;
use McpSpan\Core\Collector;
use McpSpan\Core\Definitions;
use McpSpan\Core\Event;
use McpSpan\McpSpan;

/**
 * Answers `tools/list` by handing it to the SDK's own handler, notes the tools it describes, for the fingerprint each
 * call carries (contract, 3.8), and records the answer (3.11). Claims a listing only while collecting.
 *
 * @implements RequestHandlerInterface<mixed>
 *
 * @internal
 */
final class ListToolsHandler implements RequestHandlerInterface
{
    /** @var RequestHandlerInterface<mixed>|null */
    private ?RequestHandlerInterface $delegate = null;
    private ?RegistryInterface $registry = null;

    public function __construct(private readonly Builder $builder, private readonly Connections $connections)
    {
    }

    public function supports(Request $request): bool
    {
        return $request instanceof ListToolsRequest && Collector::collecting() && $this->resolve();
    }

    public function handle(Request $request, SessionInterface $session): Response|Error
    {
        \assert(null !== $this->delegate);
        $answer = $this->delegate->handle($request, $session);
        if ($answer instanceof Response && $answer->result instanceof ListToolsResult) {
            $tools = Definitions::note($answer->result->tools);
            try {
                $call = Collector::begin('tools/list', null, Connections::client($session), $this->connections->session($session), Event::KIND_LISTING, Connections::serverVersion($this->builder));
                Collector::recordListing($call, $tools, fn (string $name): bool => McpSpan::excluded($name, $this->handlerOf($name)));
            } catch (\Throwable) {
            }
        }

        return $answer;
    }

    private function resolve(): bool
    {
        if (null === $this->delegate) {
            $parts = Internals::parts($this->builder);
            foreach ($parts['requestHandlers'] ?? [] as $handler) {
                if ($handler instanceof \Mcp\Server\Handler\Request\ListToolsHandler) {
                    $this->delegate = $handler;
                }
            }
            $registry = $parts['registry'] ?? null;
            $this->registry = $registry instanceof RegistryInterface ? $registry : null;
        }

        return null !== $this->delegate;
    }

    /** The tool's handler, for its #[Exclude] attribute; null when it cannot be found. */
    private function handlerOf(string $name): ?\Reflector
    {
        try {
            $reference = $this->registry?->getTool($name);

            return null === $reference ? null : CallToolHandler::reflect($reference->handler);
        } catch (\Throwable) {
            return null;
        }
    }
}
