<?php

declare(strict_types=1);

namespace McpSpan\Tests;

use McpSpan\Core\Failure;
use McpSpan\Core\Reporter;
use McpSpan\Tests\Support\Capture;
use PHPUnit\Framework\TestCase;

final class ReporterTest extends TestCase
{
    /** @var list<array{string, bool}> */
    private array $said = [];

    private function reporter(Capture $capture, int $batch = 100, int $queue = 100, float $interval = 3600): Reporter
    {
        return new Reporter('test', $capture->__invoke(...), $interval, $batch, $queue, function (string $message, bool $always): void {
            $this->said[] = [$message, $always];
        });
    }

    /** @return array<string, mixed> */
    private static function event(string $name): array
    {
        return ['toolName' => $name];
    }

    private static function failure(int $status, bool $retryable, float $retryAfter = 0.0): Failure
    {
        return new Failure((string) $status, $status, $retryable, $retryAfter);
    }

    public function testBackoffDoublesToACeilingWithinTheSpread(): void
    {
        self::assertEqualsWithDelta(0.5, Reporter::backoff(1, 0.0), 1e-9);
        self::assertEqualsWithDelta(1.0, Reporter::backoff(1, 1.0), 1e-9);
        self::assertEqualsWithDelta(4.0, Reporter::backoff(3, 1.0), 1e-9);
        self::assertEqualsWithDelta(60.0, Reporter::backoff(30, 1.0), 1e-9);
    }

    public function testSplitsWhatIsQueuedIntoBatches(): void
    {
        $capture = new Capture();
        $reporter = $this->reporter($capture, batch: 2);
        foreach (['a', 'b', 'c'] as $name) {
            $reporter->record(self::event($name));
        }
        $reporter->deliver();

        self::assertSame([['a', 'b'], ['c']], $capture->names());
    }

    public function testAFullBatchOrAnElapsedIntervalIsDue(): void
    {
        $reporter = $this->reporter(new Capture(), batch: 2);
        $reporter->record(self::event('a'));
        self::assertFalse($reporter->due());
        $reporter->record(self::event('b'));
        self::assertTrue($reporter->due());

        $waiting = $this->reporter(new Capture(), interval: 0.01);
        $waiting->record(self::event('a'));
        usleep(20_000);
        self::assertTrue($waiting->due());
    }

    public function testKeepsABatchThatMaySucceedLaterAndWaitsBeforeTryingAgain(): void
    {
        $capture = new Capture([self::failure(503, true)]);
        $reporter = $this->reporter($capture);
        $reporter->record(self::event('a'));
        $reporter->deliver();
        $reporter->deliver();
        self::assertCount(1, $capture->batches, 'not tried again within the backoff');

        $reporter->deliver(true);
        self::assertSame([['a'], ['a']], $capture->names());
    }

    public function testWaitsAsLongAsRetryAfterAsks(): void
    {
        $reporter = $this->reporter(new Capture([self::failure(429, true, 120.0)]));
        $reporter->record(self::event('a'));
        $reporter->deliver();

        self::assertGreaterThan(119.0, $reporter->wait());
        self::assertFalse($reporter->due());
    }

    public function testDropsABatchRefusedAsMalformedAndCarriesOn(): void
    {
        $capture = new Capture([self::failure(400, false)]);
        $reporter = $this->reporter($capture);
        $reporter->record(self::event('a'));
        $reporter->deliver();
        $reporter->record(self::event('b'));
        $reporter->deliver(true);

        self::assertSame([['a'], ['b']], $capture->names());
    }

    public function testAFullQueueDropsTheOldest(): void
    {
        $capture = new Capture();
        $reporter = $this->reporter($capture, queue: 2);
        foreach (['a', 'b', 'c'] as $name) {
            $reporter->record(self::event($name));
        }
        $reporter->deliver();

        self::assertSame([['b', 'c']], $capture->names());
    }

    public function testARefusedKeyStopsForGoodAndSaysSoOnceEvenWithoutDebug(): void
    {
        foreach ([401, 403] as $status) {
            $this->said = [];
            $capture = new Capture([self::failure($status, false)]);
            $reporter = $this->reporter($capture);
            $reporter->announce();
            $reporter->record(self::event('a'));
            $reporter->deliver(true);

            self::assertSame([[]], $capture->batches, "nothing after a {$status}");
            self::assertCount(1, $this->said);
            self::assertStringContainsString("rejected the API key (HTTP {$status})", $this->said[0][0]);
            self::assertTrue($this->said[0][1], 'said even without debug');
        }
    }
}
