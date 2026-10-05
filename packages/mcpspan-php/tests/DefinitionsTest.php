<?php

declare(strict_types=1);

namespace McpSpan\Tests;

use McpSpan\Core\Definitions;
use PHPUnit\Framework\TestCase;

final class DefinitionsTest extends TestCase
{
    protected function tearDown(): void
    {
        Definitions::forget();
    }

    public function testFingerprintsTheSharedCasesAsEverySdkDoes(): void
    {
        $shared = json_decode((string) file_get_contents(__DIR__.'/../../../conformance/definition-hashes.json'), false, 512, \JSON_THROW_ON_ERROR);
        self::assertIsObject($shared);

        foreach ($shared->cases as $case) {
            self::assertSame($case->hash, Definitions::hash($case->tool), $case->case);
        }
    }

    public function testKeepsTheLatestListedFingerprintOfEachToolAndAnEmptySchemaAsAnObject(): void
    {
        Definitions::note([['name' => 'a', 'description' => 'one'], ['name' => 'b', 'inputSchema' => ['type' => 'object', 'properties' => new \stdClass()]]]);
        Definitions::note([['name' => 'a', 'description' => 'two'], ['description' => 'nameless']]);
        Definitions::note(\NAN);

        self::assertSame(Definitions::hash((object) ['name' => 'a', 'description' => 'two']), Definitions::of('a'));
        self::assertSame(Definitions::hash((object) ['name' => 'b', 'inputSchema' => (object) ['type' => 'object', 'properties' => new \stdClass()]]), Definitions::of('b'));
        self::assertNull(Definitions::of('c'));
    }
}
