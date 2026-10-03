<?php

declare(strict_types=1);

namespace McpSpan\Core;

/**
 * Limits the ingest API enforces, and the text that has to fit them. A batch holding one field over its limit is
 * refused whole, so everything that comes from outside the developer's control is cut before it is sent.
 *
 * @internal
 */
final class Text
{
    public const MAX_NAME = 200;
    public const MAX_EXCEPTION_MESSAGE = 500;
    public const MAX_RESULT_MESSAGE = 200;
    public const MAX_DESCRIBED_PARAMETERS = 50;
    /** A release, a tag, a commit: the server's or the client's. */
    public const MAX_VERSION = 100;

    /** First match wins, so `claude-code` is tested before `claude`. */
    private const CLIENT_TYPES = [
        [['claude-code', 'claude code'], 'claude-code'],
        [['claude'], 'claude'],
        [['cursor'], 'cursor'],
        [['chatgpt', 'openai'], 'chatgpt'],
        [['inspector'], 'mcp-inspector'],
    ];

    /** Cuts text to a limit in characters, leaving a visible sign that something was removed. */
    public static function truncate(string $text, int $limit): string
    {
        if (self::length($text) <= $limit) {
            return $text;
        }

        return self::substring($text, $limit - 3).'...';
    }

    /** An exception's class without its namespace, as the other SDKs name theirs: BookingError, not App\\BookingError. */
    public static function errorType(\Throwable $error): string
    {
        $class = $error::class;
        $slash = strrpos($class, '\\');

        return self::truncate(false === $slash ? $class : substr($class, $slash + 1), self::MAX_NAME);
    }

    public static function clientType(?string $name): string
    {
        if (null === $name || '' === trim($name)) {
            return 'unknown';
        }
        $lower = strtolower($name);
        foreach (self::CLIENT_TYPES as [$needles, $type]) {
            foreach ($needles as $needle) {
                if (str_contains($lower, $needle)) {
                    return $type;
                }
            }
        }

        return 'other';
    }

    public static function version(?string $version): ?string
    {
        if (null === $version || '' === trim($version)) {
            return null;
        }

        return self::truncate(trim($version), self::MAX_VERSION);
    }

    public static function clientName(?string $name): ?string
    {
        if (null === $name || '' === trim($name)) {
            return null;
        }

        return self::truncate($name, self::MAX_NAME);
    }

    /**
     * Parameter names and their JSON types. Values are never read beyond their type.
     *
     * @param array<array-key, mixed>|null $arguments
     *
     * @return array<string, string>|null
     */
    public static function describeParameters(?array $arguments): ?array
    {
        if (null === $arguments || [] === $arguments) {
            return null;
        }
        $described = [];
        foreach (\array_slice($arguments, 0, self::MAX_DESCRIBED_PARAMETERS, true) as $name => $value) {
            $described[self::truncate((string) $name, self::MAX_NAME)] = self::jsonType($value);
        }

        return $described;
    }

    public static function jsonType(mixed $value): string
    {
        return match (true) {
            null === $value => 'null',
            \is_bool($value) => 'boolean',
            \is_int($value), \is_float($value) => 'number',
            \is_string($value) => 'string',
            \is_array($value) && array_is_list($value) && [] !== $value => 'array',
            // A decoded JSON object with no keys and an empty list look the same in PHP; a list it is.
            \is_array($value) && [] === $value => 'array',
            default => 'object',
        };
    }

    private static function length(string $text): int
    {
        return \function_exists('mb_strlen') ? mb_strlen($text, 'UTF-8') : \count(self::characters($text));
    }

    private static function substring(string $text, int $length): string
    {
        return \function_exists('mb_substr')
            ? mb_substr($text, 0, $length, 'UTF-8')
            : implode('', \array_slice(self::characters($text), 0, $length));
    }

    /** @return list<string> */
    private static function characters(string $text): array
    {
        return preg_split('//u', $text, -1, \PREG_SPLIT_NO_EMPTY) ?: str_split($text);
    }
}
