<?php

declare(strict_types=1);

namespace McpSpan\McpSdk;

use Mcp\Capability\Registry\ToolReference;
use Mcp\Capability\RegistryInterface;
use Mcp\Exception\MissingRequiredClientCapabilityException;
use Mcp\Schema\JsonRpc\Error;
use Mcp\Schema\JsonRpc\Request;
use Mcp\Schema\JsonRpc\Response;
use Mcp\Schema\Request\CallToolRequest;
use Mcp\Schema\Result\CallToolResult;
use Mcp\Server\Builder;
use Mcp\Server\Handler\Request\RequestHandlerInterface;
use Mcp\Server\Session\SessionInterface;
use McpSpan\Core\Call;
use McpSpan\Core\Collector;
use McpSpan\Core\Event;
use McpSpan\Core\Text;
use McpSpan\McpSpan;
use McpSpan\Measuring;

/**
 * Answers `tools/call` by handing it to the SDK's own handler, and records how it went. The SDK consults handlers
 * added to the builder before its own, on both protocol revisions; this one claims a call only while collecting,
 * so without a key the SDK answers as it always does.
 *
 * @implements RequestHandlerInterface<mixed>
 *
 * @internal
 */
final class CallToolHandler implements RequestHandlerInterface
{
    /** @var RequestHandlerInterface<mixed>|null */
    private ?RequestHandlerInterface $delegate = null;
    private ?RegistryInterface $registry = null;

    public function __construct(private readonly Builder $builder, private readonly Connections $connections)
    {
    }

    public function supports(Request $request): bool
    {
        return $request instanceof CallToolRequest && Collector::collecting() && $this->resolve();
    }

    public function handle(Request $request, SessionInterface $session): Response|Error
    {
        \assert($request instanceof CallToolRequest && null !== $this->delegate);

        $state = new CallState();
        $call = null;
        $exists = false;
        try {
            $reference = $this->tool($request->name);
            $exists = null !== $reference;
            if (!McpSpan::excluded($request->name, null === $reference ? null : self::reflect($reference->handler))) {
                $call = Collector::begin($request->name, $request->arguments, Connections::client($session), $this->connections->session($session), null, Connections::serverVersion($this->builder));
                ReferenceHandler::watch($request, $state);
            }
        } catch (\Throwable) {
        }

        Measuring::enter();
        try {
            $answer = $this->delegate->handle($request, $session);
        } catch (\Throwable $e) {
            // The client never declared a capability the tool needs: the request could not be served, and the
            // tool did not fail.
            if (null !== $call && !$e instanceof MissingRequiredClientCapabilityException) {
                $this->settle($call, $exists, $state, Error::forInternalError('', $request->getId()), $e);
            }
            throw $e;
        } finally {
            Measuring::leave();
        }

        if (null !== $call) {
            $this->settle($call, $exists, $state, $answer, $state->thrown);
        }

        return $answer;
    }

    /** @param Response<mixed>|Error $answer */
    private function settle(Call $call, bool $exists, CallState $state, Response|Error $answer, ?\Throwable $thrown): void
    {
        try {
            if ($answer instanceof Error) {
                if (!$exists) {
                    Collector::record($call, false, Event::SOURCE_UNKNOWN_TOOL);
                } elseif (!$state->reached) {
                    // The SDK refuses arguments that fail the tool's input schema, before the tool runs.
                    Collector::record($call, false, Event::SOURCE_ARGUMENTS);
                } else {
                    $type = null === $thrown ? 'Error' : Text::errorType($thrown);
                    $message = Text::truncate(null === $thrown ? $answer->message : $thrown->getMessage(), Text::MAX_EXCEPTION_MESSAGE);
                    Collector::record($call, false, Event::SOURCE_EXCEPTION, $type, $message);
                }

                return;
            }

            $result = $answer->result;
            // An interim result asking the client for input settles nothing; the call that follows it does.
            if (!$result instanceof CallToolResult) {
                return;
            }
            if (!$result->isError) {
                Collector::record($call, true, response: $result);

                return;
            }
            // A ToolCallException is how a tool reports its own error, as a result the model reads.
            Collector::record($call, false, Event::SOURCE_RESULT, null, self::text($result), $result);
        } catch (\Throwable) {
        }
    }

    /** Finds the SDK's own handler and registry, once the builder has assembled them. */
    private function resolve(): bool
    {
        if (null !== $this->delegate) {
            return true;
        }
        $parts = Internals::parts($this->builder);
        foreach ($parts['requestHandlers'] ?? [] as $handler) {
            if ($handler instanceof \Mcp\Server\Handler\Request\CallToolHandler) {
                $this->delegate = $handler;
            }
        }
        $registry = $parts['registry'] ?? null;
        $this->registry = $registry instanceof RegistryInterface ? $registry : null;

        return null !== $this->delegate;
    }

    private function tool(string $name): ?ToolReference
    {
        try {
            return $this->registry?->getTool($name);
        } catch (\Throwable) {
            return null;
        }
    }

    private static function text(CallToolResult $result): string
    {
        $texts = [];
        foreach ($result->content as $block) {
            if ($block instanceof \Mcp\Schema\Content\TextContent) {
                $texts[] = $block->text;
            }
        }

        return Text::truncate(trim(implode(' ', $texts)), Text::MAX_RESULT_MESSAGE);
    }

    /** The function a tool's handler runs, for its attributes. */
    private static function reflect(mixed $handler): ?\Reflector
    {
        try {
            return match (true) {
                $handler instanceof \Closure => new \ReflectionFunction($handler),
                \is_array($handler) && 2 === \count($handler) => new \ReflectionMethod($handler[0], $handler[1]),
                \is_string($handler) && str_contains($handler, '::') => new \ReflectionMethod($handler),
                \is_string($handler) && class_exists($handler) => new \ReflectionMethod($handler, '__invoke'),
                \is_string($handler) && \function_exists($handler) => new \ReflectionFunction($handler),
                \is_object($handler) => new \ReflectionMethod($handler, '__invoke'),
                default => null,
            };
        } catch (\Throwable) {
            return null;
        }
    }
}
