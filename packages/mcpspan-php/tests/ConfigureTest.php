<?php

declare(strict_types=1);

namespace McpSpan\Tests;

use McpSpan\Core\Collector;
use McpSpan\McpSpan;
use McpSpan\Tests\Support\UsesCapture;
use PHPUnit\Framework\TestCase;

final class ConfigureTest extends TestCase
{
    use UsesCapture;

    public function testTheSameSettingsAgainChangeNothing(): void
    {
        $capture = $this->capture();
        McpSpan::configure(['apiKey' => 'mk_test', 'flushInterval' => 3600]);

        self::assertTrue(McpSpan::collecting());
        self::assertSame([], $capture->batches, 'no second start');
    }

    public function testAMalformedSettingFallsBackToItsDefaultAndSaysSoWhenAsked(): void
    {
        $said = [];
        $settings = Collector::resolve([
            'flushInterval' => -1, 'maxBatchSize' => 'ten', 'maxQueueSize' => 0, 'colour' => 'blue',
            'onDiagnostic' => static function (string $message) use (&$said): void {
                $said[] = $message;
            },
        ]);

        self::assertSame(5.0, $settings['flushInterval']);
        self::assertSame(100, $settings['maxBatchSize']);
        self::assertSame(10_000, $settings['maxQueueSize']);
        self::assertTrue($settings['debug'], 'a callback implies debug');
        self::assertCount(4, $said);
    }

    public function testWithAKeyAndNoEndpointCollectsNothingAndSaysSoOnce(): void
    {
        putenv('MCPSPAN_ENDPOINT');
        Collector::forgetNoEndpointNotice();
        $said = [];
        $settings = ['apiKey' => 'k', 'onDiagnostic' => static function (string $message) use (&$said): void {
            $said[] = $message;
        }];

        Collector::configure($settings);
        Collector::configure($settings);

        self::assertFalse(Collector::collecting());
        self::assertSame([Collector::NO_ENDPOINT], $said);
    }

    public function testReadsTheKeyAndTheEndpointFromTheEnvironment(): void
    {
        putenv('MCPSPAN_API_KEY= mk_env ');
        putenv('MCPSPAN_ENDPOINT=http://mcpspan.internal');
        try {
            $settings = Collector::resolve([]);
            self::assertSame('mk_env', $settings['apiKey']);
            self::assertSame('http://mcpspan.internal', $settings['endpoint']);
            putenv('MCPSPAN_ENDPOINT');
            self::assertSame('', Collector::resolve(['endpoint' => ' '])['endpoint']);
        } finally {
            putenv('MCPSPAN_API_KEY');
            putenv('MCPSPAN_ENDPOINT');
        }
    }

    public function testWithoutAKeyNothingStarts(): void
    {
        McpSpan::configure(['apiKey' => '']);

        self::assertFalse(McpSpan::collecting());
    }

    public function testNothingThrowsOverASetting(): void
    {
        McpSpan::configure(['apiKey' => 42, 'flushInterval' => 'soon', 'onDiagnostic' => 'not callable']);

        self::assertFalse(McpSpan::collecting());
    }

    public function testATrackedHandlerIsMeasuredAndPassesItsResultAndExceptionOn(): void
    {
        $capture = $this->capture();
        $search = McpSpan::track('search', static fn (string $to): string => "to {$to}");
        $book = McpSpan::track('book', static fn (): never => throw new \DomainException('full'));

        self::assertSame('to LIS', $search('LIS'));
        try {
            $book();
            self::fail('the exception reaches the caller');
        } catch (\DomainException) {
        }
        $events = $this->delivered();

        self::assertTrue($events[0]['success']);
        self::assertSame(['exception', 'DomainException', 'full'], [$events[1]['errorSource'], $events[1]['errorType'], $events[1]['errorMessage']]);
        self::assertArrayNotHasKey('sessionId', $events[0]);
        self::assertCount(2, $capture->events());
    }
}
