<?php

declare(strict_types=1);

namespace McpSpan\Core;

/**
 * Which top-level arguments of a refused call did not match the tool's input schema (contract, 3.10). The server's
 * own refusal is not read: each validation library words it differently, and some quote the value the agent sent.
 * The arguments are checked here instead, against the schema the server listed, by a small set of rules that never
 * fail what they do not understand. Only names the schema declares come out, so nothing the client made up, and no
 * value, is sent.
 *
 * @internal
 */
final class ArgumentChecks
{
    /** Names sent at most, per call. */
    private const MAX_NAMES = 20;

    /**
     * The declared names whose arguments fail the schema, sorted, at most twenty. Both are read the way they were
     * sent, written to JSON and read back; an empty PHP array of arguments is the empty object it stands for. Never
     * throws.
     *
     * @return list<string>
     */
    public static function invalid(mixed $schema, mixed $arguments): array
    {
        try {
            $rules = self::plain($schema);
            if (!$rules instanceof \stdClass) {
                return [];
            }
            $values = null === $arguments || [] === $arguments ? new \stdClass() : self::plain($arguments);
            if (!$values instanceof \stdClass) {
                return [];
            }

            $names = [];
            if (isset($rules->required) && \is_array($rules->required)) {
                foreach ($rules->required as $name) {
                    if (\is_string($name) && !property_exists($values, $name)) {
                        $names[$name] = true;
                    }
                }
            }
            if (isset($rules->properties) && $rules->properties instanceof \stdClass) {
                foreach (get_object_vars($rules->properties) as $name => $rule) {
                    $name = (string) $name;
                    if (property_exists($values, $name) && !self::matches($rule, $values->{$name})) {
                        $names[$name] = true;
                    }
                }
            }

            $sorted = array_map('strval', array_keys($names));
            sort($sorted, \SORT_STRING);

            return \array_slice($sorted, 0, self::MAX_NAMES);
        } catch (\Throwable) {
            return [];
        }
    }

    private static function plain(mixed $value): mixed
    {
        return json_decode(json_encode($value, \JSON_THROW_ON_ERROR), false, 512, \JSON_THROW_ON_ERROR);
    }

    /** Whether a value passes a schema under the checks the contract lists, and only those. */
    private static function matches(mixed $schema, mixed $value): bool
    {
        if (false === $schema) {
            return false;
        }
        if (!$schema instanceof \stdClass) {
            return true;
        }
        $rules = get_object_vars($schema);

        $type = $rules['type'] ?? null;
        if (\is_string($type) && !self::isType($type, $value)) {
            return false;
        }
        if (\is_array($type) && array_filter($type, 'is_string') === $type
            && [] === array_filter($type, static fn (string $name): bool => self::isType($name, $value))) {
            return false;
        }

        if (isset($rules['enum']) && \is_array($rules['enum'])) {
            $sent = Definitions::canonicalText($value);
            $found = false;
            foreach ($rules['enum'] as $option) {
                if (Definitions::canonicalText($option) === $sent) {
                    $found = true;
                    break;
                }
            }
            if (!$found) {
                return false;
            }
        }
        if (\array_key_exists('const', $rules) && Definitions::canonicalText($rules['const']) !== Definitions::canonicalText($value)) {
            return false;
        }

        $bound = static fn (string $name): int|float|null => self::isNumber($rules[$name] ?? null) ? $rules[$name] : null;
        if (self::isNumber($value)) {
            if ((null !== $minimum = $bound('minimum')) && $value < $minimum) {
                return false;
            }
            if ((null !== $maximum = $bound('maximum')) && $value > $maximum) {
                return false;
            }
            if ((null !== $above = $bound('exclusiveMinimum')) && $value <= $above) {
                return false;
            }
            if ((null !== $below = $bound('exclusiveMaximum')) && $value >= $below) {
                return false;
            }
        }

        if (\is_string($value)) {
            // Code points, counted without mbstring, which not every PHP has.
            $length = (int) preg_match_all('/./su', $value);
            if ((null !== $shortest = $bound('minLength')) && $length < $shortest) {
                return false;
            }
            if ((null !== $longest = $bound('maxLength')) && $length > $longest) {
                return false;
            }
        }

        if (\is_array($value)) {
            if ((null !== $fewest = $bound('minItems')) && \count($value) < $fewest) {
                return false;
            }
            if ((null !== $most = $bound('maxItems')) && \count($value) > $most) {
                return false;
            }
            $each = $rules['items'] ?? null;
            if ($each instanceof \stdClass || \is_bool($each)) {
                foreach ($value as $item) {
                    if (!self::matches($each, $item)) {
                        return false;
                    }
                }
            }
        }

        if ($value instanceof \stdClass) {
            if (isset($rules['required']) && \is_array($rules['required'])) {
                foreach ($rules['required'] as $name) {
                    if (\is_string($name) && !property_exists($value, $name)) {
                        return false;
                    }
                }
            }
            if (isset($rules['properties']) && $rules['properties'] instanceof \stdClass) {
                foreach (get_object_vars($rules['properties']) as $name => $rule) {
                    $name = (string) $name;
                    if (property_exists($value, $name) && !self::matches($rule, $value->{$name})) {
                        return false;
                    }
                }
            }
        }

        return true;
    }

    private static function isType(string $type, mixed $value): bool
    {
        return match ($type) {
            'string' => \is_string($value),
            'number' => self::isNumber($value),
            'integer' => self::isNumber($value) && floor((float) $value) === (float) $value,
            'boolean' => \is_bool($value),
            'object' => $value instanceof \stdClass,
            'array' => \is_array($value),
            'null' => null === $value,
            // A type this list does not know is not checked.
            default => true,
        };
    }

    private static function isNumber(mixed $value): bool
    {
        return \is_int($value) || (\is_float($value) && is_finite($value));
    }
}
