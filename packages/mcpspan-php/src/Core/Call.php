<?php

declare(strict_types=1);

namespace McpSpan\Core;

/**
 * What an integration knows about one call as it starts. A kind of null is a tool call.
 *
 * @internal
 */
final class Call
{
    /** @param array<string, string>|null $parameters */
    public function __construct(
        public readonly string $toolName,
        public readonly ?array $parameters,
        public readonly ?string $clientName,
        public readonly ?string $sessionId,
        public readonly int $started,
        public readonly float $timestamp,
        public readonly ?string $kind = null,
        public readonly ?string $clientVersion = null,
        /** The one the SDK was told, or else the one the server gives itself. */
        public readonly ?string $serverVersion = null,
    ) {
    }

    /** The arguments were the previous call's to the same tool in this session (contract, 3.9). */
    public bool $repeated = false;

    /**
     * Compares the arguments, as the client sent them, with the previous call's to the same tool in this session,
     * once, as the request arrives; unless the call continues an earlier one.
     */
    public function compareArguments(mixed $arguments, bool $continues = false): void
    {
        if (null !== $this->sessionId && null === $this->kind && !$continues) {
            $this->repeated = Repeats::note($this->sessionId, $this->toolName, $arguments);
        }
    }

    /** Says this call ended asking the client for more, so the retry that answers is not its repeat. */
    public function endedInterim(): void
    {
        if (null !== $this->sessionId) {
            Repeats::interim($this->sessionId, $this->toolName);
        }
    }
}
