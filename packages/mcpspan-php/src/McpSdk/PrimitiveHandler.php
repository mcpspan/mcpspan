<?php

declare(strict_types=1);

namespace McpSpan\McpSdk;

use Mcp\Capability\Registry\PromptReference;
use Mcp\Capability\Registry\ResourceReference;
use Mcp\Capability\Registry\ResourceTemplateReference;
use Mcp\Capability\RegistryInterface;
use Mcp\Exception\MissingRequiredClientCapabilityException;
use Mcp\Schema\JsonRpc\Error;
use Mcp\Schema\JsonRpc\Request;
use Mcp\Schema\JsonRpc\Response;
use Mcp\Schema\Request\GetPromptRequest;
use Mcp\Schema\Request\ReadResourceRequest;
use Mcp\Schema\Result\InputRequiredResult;
use Mcp\Server\Builder;
use Mcp\Server\Handler\Request\GetPromptHandler;
use Mcp\Server\Handler\Request\ReadResourceHandler;
use Mcp\Server\Handler\Request\RequestHandlerInterface;
use Mcp\Server\Session\SessionInterface;
use McpSpan\Core\Call;
use McpSpan\Core\Collector;
use McpSpan\Core\Event;
use McpSpan\Core\Text;

/**
 * Answers `resources/read` and `prompts/get` (contract, 3.5) by handing them to the SDK's own handlers, and records
 * how they went, as {@see CallToolHandler} does for tools.
 *
 * What was asked for is named before anything runs, from the SDK's registry: a fixed resource by its URI, a templated
 * one by its template, never by the address the client sent, and an address with neither by its scheme alone, since
 * the rest of it came from the client. The SDK refuses a prompt got without an argument it requires inside its
 * reference handler, before the prompt's function runs; which arguments a prompt requires is in its registration.
 *
 * @implements RequestHandlerInterface<mixed>
 *
 * @internal
 */
final class PrimitiveHandler implements RequestHandlerInterface
{
    /** @var RequestHandlerInterface<mixed>|null */
    private ?RequestHandlerInterface $resources = null;
    /** @var RequestHandlerInterface<mixed>|null */
    private ?RequestHandlerInterface $prompts = null;
    private ?RegistryInterface $registry = null;
    private bool $resolved = false;

    public function __construct(private readonly Builder $builder, private readonly Connections $connections)
    {
    }

    public function supports(Request $request): bool
    {
        return ($request instanceof ReadResourceRequest || $request instanceof GetPromptRequest)
            && Collector::collecting()
            && null !== $this->delegate($request);
    }

    public function handle(Request $request, SessionInterface $session): Response|Error
    {
        $delegate = $this->delegate($request);
        \assert(null !== $delegate);

        $state = new CallState();
        $call = null;
        $known = false;
        $refused = false;
        try {
            [$call, $known, $refused] = $this->begin($request, $session);
            if (null !== $call) {
                ReferenceHandler::watch($request, $state);
            }
        } catch (\Throwable) {
        }

        try {
            $answer = $delegate->handle($request, $session);
        } catch (\Throwable $e) {
            // The client never declared a capability the handler needs: the request could not be served.
            if (null !== $call && !$e instanceof MissingRequiredClientCapabilityException) {
                $this->settle($call, $request, $known, $refused, $state, Error::forInternalError('', $request->getId()), $e);
            }
            throw $e;
        }

        if (null !== $call) {
            $this->settle($call, $request, $known, $refused, $state, $answer, $state->thrown);
        }

        return $answer;
    }

    /** @return array{?Call, bool, bool} the call, whether the server has what was asked for, and whether it will refuse its arguments */
    private function begin(Request $request, SessionInterface $session): array
    {
        $client = Connections::client($session);
        $sessionId = $this->connections->session($session);
        $serverVersion = Connections::serverVersion($this->builder);

        if ($request instanceof ReadResourceRequest) {
            $reference = $this->resource($request->uri);
            [$name, $variables] = match (true) {
                $reference instanceof ResourceTemplateReference => [$reference->resourceTemplate->uriTemplate, $reference->extractVariables($request->uri)],
                $reference instanceof ResourceReference => [$reference->resource->uri, null],
                default => [Event::scheme($request->uri), null],
            };
            $call = Collector::begin($name, $variables, $client, $sessionId, Event::KIND_RESOURCE, $serverVersion);

            return [$call, null !== $reference, false];
        }

        \assert($request instanceof GetPromptRequest);
        $reference = $this->prompt($request->name);
        $call = Collector::begin($request->name, $request->arguments, $client, $sessionId, Event::KIND_PROMPT, $serverVersion);

        return [$call, null !== $reference, null !== $reference && self::missing($reference, $request->arguments ?? [])];
    }

    /** @param Response<mixed>|Error $answer */
    private function settle(Call $call, Request $request, bool $known, bool $refused, CallState $state, Response|Error $answer, ?\Throwable $thrown): void
    {
        try {
            if ($answer instanceof Response) {
                // An interim result asking the client for input settles nothing; the request that follows it does.
                if (!$answer->result instanceof InputRequiredResult) {
                    Collector::record($call, true, response: $answer->result);
                }

                return;
            }
            if (!$known) {
                Collector::record($call, false, $request instanceof ReadResourceRequest ? Event::SOURCE_UNKNOWN_RESOURCE : Event::SOURCE_UNKNOWN_PROMPT);
            } elseif ($refused) {
                Collector::record($call, false, Event::SOURCE_ARGUMENTS);
            } else {
                $type = null === $thrown ? 'Error' : Text::errorType($thrown);
                $message = Text::truncate(null === $thrown ? $answer->message : $thrown->getMessage(), Text::MAX_EXCEPTION_MESSAGE);
                Collector::record($call, false, Event::SOURCE_EXCEPTION, $type, $message);
            }
        } catch (\Throwable) {
        }
    }

    /**
     * Whether a prompt is got without an argument its registration requires.
     *
     * @param array<array-key, mixed> $arguments
     */
    private static function missing(PromptReference $reference, array $arguments): bool
    {
        foreach ($reference->prompt->arguments ?? [] as $argument) {
            if (true === $argument->required && !\array_key_exists($argument->name, $arguments)) {
                return true;
            }
        }

        return false;
    }

    /** @return RequestHandlerInterface<mixed>|null */
    private function delegate(Request $request): ?RequestHandlerInterface
    {
        if (!$this->resolved) {
            // The builder assembles its parts as it builds the server; until then there is nothing to find.
            $parts = Internals::parts($this->builder);
            if (null === $parts) {
                return null;
            }
            $this->resolved = true;
            foreach ($parts['requestHandlers'] ?? [] as $handler) {
                if ($handler instanceof ReadResourceHandler) {
                    $this->resources = $handler;
                } elseif ($handler instanceof GetPromptHandler) {
                    $this->prompts = $handler;
                }
            }
            $registry = $parts['registry'] ?? null;
            $this->registry = $registry instanceof RegistryInterface ? $registry : null;
        }
        if (null === $this->registry) {
            return null;
        }

        return $request instanceof ReadResourceRequest ? $this->resources : $this->prompts;
    }

    private function resource(string $uri): ResourceReference|ResourceTemplateReference|null
    {
        try {
            return $this->registry?->getResource($uri);
        } catch (\Throwable) {
            return null;
        }
    }

    private function prompt(string $name): ?PromptReference
    {
        try {
            return $this->registry?->getPrompt($name);
        } catch (\Throwable) {
            return null;
        }
    }
}
