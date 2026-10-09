<?php

declare(strict_types=1);

namespace McpSpan\Tests;

use McpSpan\Core\ArgumentChecks;
use PHPUnit\Framework\TestCase;

final class ArgumentChecksTest extends TestCase
{
    public function testFindsTheSharedCasesAsEverySdkDoes(): void
    {
        $shared = json_decode((string) file_get_contents(__DIR__.'/../../../conformance/argument-checks.json'), false, 512, \JSON_THROW_ON_ERROR);
        self::assertIsObject($shared);

        foreach ($shared->cases as $case) {
            self::assertSame($case->invalid, ArgumentChecks::invalid($case->schema, $case->arguments), $case->case);
        }
    }

    public function testReadsAnEmptyArrayOfArgumentsAsTheEmptyObjectItStandsFor(): void
    {
        self::assertSame(['destination'], ArgumentChecks::invalid(['type' => 'object', 'required' => ['destination']], []));
    }

    public function testFindsNothingWithoutASchema(): void
    {
        self::assertSame([], ArgumentChecks::invalid(null, ['passengers' => 2]));
    }
}
