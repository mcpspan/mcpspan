<?php

declare(strict_types=1);

namespace McpSpan\Core;

/**
 * Tool definitions as the server lists them, fingerprinted (contract, 3.8). Rewording a description can change how
 * agents use a tool more than a change to its code; the fingerprint is taken from the answer to `tools/list`, what
 * an agent actually read, and sent with every call to the tool. Kept for the process: one process reports to one
 * server.
 *
 * @internal
 */
final class Definitions
{
    private const HASHED = ['name', 'title', 'description', 'inputSchema'];

    private const ESCAPES = ['"' => '\\"', '\\' => '\\\\', "\x08" => '\\b', "\f" => '\\f', "\n" => '\\n', "\r" => '\\r', "\t" => '\\t'];

    /** @var array<string, string> */
    private static array $listed = [];

    /** The latest fingerprint listed for a tool, or null when no listing in this process named it. */
    public static function of(string $toolName): ?string
    {
        return self::$listed[$toolName] ?? null;
    }

    /**
     * Notes every tool in a listing, in whatever shape the SDK keeps them, written to JSON and read back as the
     * client reads it: an empty object stays an object. Never throws.
     */
    public static function note(mixed $tools): void
    {
        try {
            $wire = json_decode(json_encode($tools, \JSON_THROW_ON_ERROR), false, 512, \JSON_THROW_ON_ERROR);
            if (!\is_array($wire)) {
                return;
            }
            foreach ($wire as $tool) {
                if ($tool instanceof \stdClass && isset($tool->name) && \is_string($tool->name)) {
                    $hash = self::hash($tool);
                    if (null !== $hash) {
                        self::$listed[$tool->name] = $hash;
                    }
                }
            }
        } catch (\Throwable) {
        }
    }

    /** For tests: forgets every listing. */
    public static function forget(): void
    {
        self::$listed = [];
    }

    /**
     * The first 16 hex characters of the SHA-256 of the tool's name, title, description and input schema, as
     * canonical JSON; null for a definition that cannot be written so.
     */
    public static function hash(\stdClass $tool): ?string
    {
        try {
            $hashed = new \stdClass();
            foreach (self::HASHED as $field) {
                if (isset($tool->{$field})) {
                    $hashed->{$field} = $tool->{$field};
                }
            }

            return substr(hash('sha256', self::canonical($hashed)), 0, 16);
        } catch (\Throwable) {
            return null;
        }
    }

    /**
     * A value as canonical JSON (contract, 3.8), read the way it was sent: written to JSON and read back, so an empty
     * object stays an object. Throws on what cannot be written so.
     */
    public static function canonicalText(mixed $value): string
    {
        return self::canonical(json_decode(json_encode($value, \JSON_THROW_ON_ERROR), false, 512, \JSON_THROW_ON_ERROR));
    }

    /** Sorted keys, no whitespace, minimal escaping: the same text in every SDK. */
    private static function canonical(mixed $value): string
    {
        if (null === $value) {
            return 'null';
        }
        if (\is_bool($value)) {
            return $value ? 'true' : 'false';
        }
        if (\is_int($value)) {
            return (string) $value;
        }
        if (\is_float($value)) {
            if (!is_finite($value)) {
                throw new \InvalidArgumentException('not a JSON number');
            }

            return floor($value) === $value && abs($value) < 1e15 ? (string) (int) $value : json_encode($value, \JSON_THROW_ON_ERROR);
        }
        if (\is_string($value)) {
            return self::text($value);
        }
        if ($value instanceof \stdClass) {
            $object = get_object_vars($value);
            $keys = array_map('strval', array_keys($object));
            sort($keys, \SORT_STRING);

            return '{'.implode(',', array_map(static fn (string $key): string => self::text($key).':'.self::canonical($object[$key]), $keys)).'}';
        }
        if (\is_array($value)) {
            return '['.implode(',', array_map(self::canonical(...), array_values($value))).']';
        }

        throw new \InvalidArgumentException('cannot fingerprint '.get_debug_type($value));
    }

    private static function text(string $value): string
    {
        // Byte by byte: everything escaped is one byte, and every byte of a longer UTF-8 character is above 0x7f.
        $out = '"';
        for ($i = 0, $length = \strlen($value); $i < $length; ++$i) {
            $byte = $value[$i];
            $out .= self::ESCAPES[$byte] ?? (\ord($byte) < 0x20 ? \sprintf('\\u%04x', \ord($byte)) : $byte);
        }

        return $out.'"';
    }
}
