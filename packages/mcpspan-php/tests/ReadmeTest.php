<?php

declare(strict_types=1);

namespace McpSpan\Tests;

use McpSpan\Core\Collector;
use McpSpan\McpSdk;
use McpSpan\McpSpan;
use PHPUnit\Framework\TestCase;

/**
 * The README's PHP samples, checked against the SDK: each parses, calls only what the SDK has, and passes only
 * settings it takes.
 */
final class ReadmeTest extends TestCase
{
    /** @return list<string> */
    private static function samples(): array
    {
        preg_match_all('/```php\n(.*?)```/s', self::readme(), $matches);

        return $matches[1];
    }

    private static function readme(): string
    {
        return (string) file_get_contents(__DIR__.'/../README.md');
    }

    public function testEverySampleParses(): void
    {
        self::assertGreaterThanOrEqual(7, \count(self::samples()));
        foreach (self::samples() as $sample) {
            // Class bodies elided with a comment parse as they are.
            token_get_all("<?php\n".$sample, \TOKEN_PARSE);
        }
        $this->addToAssertionCount(1);
    }

    public function testEverySampleCallsWhatTheSdkHas(): void
    {
        preg_match_all('/\b(McpSpan|McpSdk)::(\w+)\(/', implode("\n", self::samples()), $calls, \PREG_SET_ORDER);
        self::assertNotEmpty($calls);
        foreach ($calls as [, $class, $method]) {
            $fqcn = 'McpSpan' === $class ? McpSpan::class : McpSdk::class;
            self::assertTrue(method_exists($fqcn, $method), "{$class}::{$method} in the README");
        }
    }

    public function testEverySettingInTheReadmeIsOneTheSdkTakes(): void
    {
        preg_match_all("/'(\\w+)' =>/", implode("\n", self::samples()), $passed);
        preg_match_all('/^\| `(\w+)` \|/m', self::readme(), $listed);

        self::assertEqualsCanonicalizing(Collector::SETTINGS, $listed[1], 'the Options table');
        foreach ($passed[1] as $name) {
            self::assertContains($name, Collector::SETTINGS);
        }
    }
}
