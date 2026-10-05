<?php

declare(strict_types=1);

namespace McpSpan\Core;

use McpSpan\McpSpan;

/**
 * One call of a tool, a resource or a prompt, in the shape the ingest API takes. Parameter values are never part of it.
 *
 * @internal
 */
final class Event
{
    public const SOURCE_RESULT = 'result';
    public const SOURCE_EXCEPTION = 'exception';
    public const SOURCE_ARGUMENTS = 'arguments';
    public const SOURCE_UNKNOWN_TOOL = 'unknown_tool';
    public const SOURCE_UNKNOWN_RESOURCE = 'unknown_resource';
    public const SOURCE_UNKNOWN_PROMPT = 'unknown_prompt';

    public const KIND_RESOURCE = 'resource';
    public const KIND_PROMPT = 'prompt';

    /**
     * @param array<string, string>|null $parameters
     */
    public function __construct(
        public readonly string $id,
        public readonly string $toolName,
        public readonly float $durationMs,
        public readonly bool $success,
        public readonly ?string $errorSource,
        public readonly ?string $errorType,
        public readonly ?string $errorMessage,
        public readonly string $clientType,
        public readonly ?string $clientName,
        public readonly string $timestamp,
        public readonly ?string $sessionId,
        public readonly ?array $parameters,
        public readonly ?string $kind = null,
        public readonly ?string $clientVersion = null,
        public readonly ?string $serverVersion = null,
        /** Size of the answer, when there was one (contract, 3.7). */
        public readonly ?int $responseBytes = null,
        /** The tool's definition as last listed, fingerprinted (contract, 3.8). */
        public readonly ?string $definitionHash = null,
        /** True when the arguments were the previous call's to the same tool in this session (contract, 3.9). */
        public readonly ?bool $repeated = null,
    ) {
    }

    /**
     * The event as the API takes it, leaving absent fields out rather than sending them as null.
     *
     * @return array<string, mixed>
     */
    public function toArray(): array
    {
        return array_filter([
            'id' => $this->id,
            'kind' => $this->kind,
            'toolName' => $this->toolName,
            'durationMs' => $this->durationMs,
            'success' => $this->success,
            'errorSource' => $this->errorSource,
            'errorType' => $this->errorType,
            'errorMessage' => $this->errorMessage,
            'clientType' => $this->clientType,
            'clientName' => $this->clientName,
            'clientVersion' => $this->clientVersion,
            'serverVersion' => $this->serverVersion,
            'responseBytes' => $this->responseBytes,
            'definitionHash' => $this->definitionHash,
            'repeated' => $this->repeated,
            'timestamp' => $this->timestamp,
            'sdkVersion' => McpSpan::VERSION,
            'sessionId' => $this->sessionId,
            // An object even when PHP would take the keys for a list.
            'parameters' => null === $this->parameters ? null : (object) $this->parameters,
        ], static fn (mixed $value): bool => null !== $value);
    }

    /**
     * The body of one batch.
     *
     * @param list<array<string, mixed>> $events
     */
    public static function batch(array $events): string
    {
        return json_encode(
            ['events' => $events],
            \JSON_UNESCAPED_SLASHES | \JSON_UNESCAPED_UNICODE | \JSON_INVALID_UTF8_SUBSTITUTE | \JSON_PRESERVE_ZERO_FRACTION,
        ) ?: '{"events":[]}';
    }

    /** The scheme of an address, which is all of an unknown one that may be kept: `db://`. */
    public static function scheme(string $uri): string
    {
        return 1 === preg_match('/^([a-zA-Z][a-zA-Z0-9+.-]*):/', $uri, $match) ? $match[1].'://' : 'unknown://';
    }

    public static function uuid(): string
    {
        $bytes = random_bytes(16);
        $bytes[6] = \chr((\ord($bytes[6]) & 0x0F) | 0x40);
        $bytes[8] = \chr((\ord($bytes[8]) & 0x3F) | 0x80);

        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($bytes), 4));
    }
}
