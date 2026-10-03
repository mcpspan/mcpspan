<?php

declare(strict_types=1);

namespace McpSpan\Tests;

use McpSpan\Core\Event;
use McpSpan\Core\Text;
use PHPUnit\Framework\TestCase;

final class TextTest extends TestCase
{
    /** The contract's table as cases, shared by every SDK's tests (conformance/client-types.json). */
    public function testDetectsTheContractTable(): void
    {
        /** @var array{cases: list<array{?string, string}>} $table */
        $table = json_decode((string) file_get_contents(__DIR__.'/../../../conformance/client-types.json'), true, 512, \JSON_THROW_ON_ERROR);

        self::assertGreaterThan(10, \count($table['cases']));
        foreach ($table['cases'] as [$name, $type]) {
            self::assertSame($type, Text::clientType($name), var_export($name, true));
        }
    }

    public function testTruncateMarksACutAndKeepsCharactersWhole(): void
    {
        self::assertSame('abc', Text::truncate('abc', 5));
        self::assertSame('żó...', Text::truncate('żółwie', 5));
    }

    public function testDescribesParametersByNameAndJsonTypeOnly(): void
    {
        self::assertSame(
            ['a' => 'string', 'b' => 'number', 'c' => 'number', 'd' => 'boolean', 'e' => 'null', 'f' => 'array', 'g' => 'object'],
            Text::describeParameters(['a' => 'x', 'b' => 1, 'c' => 1.5, 'd' => true, 'e' => null, 'f' => [1], 'g' => ['h' => 1]]),
        );
        self::assertNull(Text::describeParameters([]));
        self::assertCount(50, Text::describeParameters(array_fill_keys(array_map(static fn (int $i): string => "p{$i}", range(1, 60)), 1)) ?? []);
    }

    public function testParametersAreAnObjectEvenWithNumericNames(): void
    {
        $event = new Event('id', 't', 1.0, true, null, null, null, 'unknown', null, 'now', null, ['0' => 'string']);

        self::assertSame('{"events":[{"id":"id","toolName":"t","durationMs":1.0,"success":true,"clientType":"unknown","timestamp":"now","sdkVersion":"0.1.0","parameters":{"0":"string"}}]}', Event::batch([$event->toArray()]));
    }

    public function testMakesVersionFourUuids(): void
    {
        self::assertMatchesRegularExpression('/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/', Event::uuid());
    }
}
