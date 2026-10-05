<?php

declare(strict_types=1);

namespace McpSpan\McpSdk;

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

/**
 * Answers `tools/list` by handing it to the SDK's own handler, and notes the tools it describes, for the
 * fingerprint each call carries (contract, 3.8). Claims a listing only while collecting.
 *
 * @implements RequestHandlerInterface<mixed>
 *
 * @internal
 */
final class ListToolsHandler implements RequestHandlerInterface
{
    /** @var RequestHandlerInterface<mixed>|null */
    private ?RequestHandlerInterface $delegate = null;

    public function __construct(private readonly Builder $builder)
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
            Definitions::note($answer->result->tools);
        }

        return $answer;
    }

    private function resolve(): bool
    {
        if (null === $this->delegate) {
            foreach (Internals::parts($this->builder)['requestHandlers'] ?? [] as $handler) {
                if ($handler instanceof \Mcp\Server\Handler\Request\ListToolsHandler) {
                    $this->delegate = $handler;
                }
            }
        }

        return null !== $this->delegate;
    }
}
