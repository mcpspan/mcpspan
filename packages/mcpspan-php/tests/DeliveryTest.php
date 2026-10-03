<?php

declare(strict_types=1);

namespace McpSpan\Tests;

use McpSpan\Core\HttpTransport;
use McpSpan\Core\WorkerDelivery;
use McpSpan\McpSpan;
use McpSpan\Tests\Support\Ingest;
use PHPUnit\Framework\TestCase;

/** Delivery to a real HTTP endpoint: the transport, and the worker process a long-running server starts. */
final class DeliveryTest extends TestCase
{
    /** @return array<string, mixed> */
    private static function settings(Ingest $ingest, array $overrides = []): array
    {
        return [
            'endpoint' => $ingest->endpoint, 'apiKey' => 'mk_test', 'version' => McpSpan::VERSION, 'flushInterval' => 0.2,
            'maxBatchSize' => 100, 'maxQueueSize' => 100, 'debug' => false, 'diagnosticsToParent' => false, ...$overrides,
        ];
    }

    public function testPostsABatchAndIdentifiesTheSdk(): void
    {
        $ingest = new Ingest();
        $failure = (new HttpTransport($ingest->endpoint.'/', 'mk_test', McpSpan::VERSION))->send([['toolName' => 'a']]);

        self::assertNull($failure);
        $request = $ingest->requests()[0];
        self::assertSame('/v1/events', $request['path']);
        self::assertSame('Bearer mk_test', $request['authorization']);
        self::assertSame('mcpspan/'.McpSpan::VERSION.' (php)', $request['userAgent']);
        self::assertSame(['events' => [['toolName' => 'a']]], $request['body']);
    }

    public function testTellsWhatMayBeRetried(): void
    {
        $ingest = new Ingest();
        $ingest->answer(429, '12');
        $ingest->answer(400);
        $transport = new HttpTransport($ingest->endpoint, 'mk_test', McpSpan::VERSION);

        $busy = $transport->send([]);
        self::assertTrue($busy?->retryable);
        self::assertSame(12.0, $busy?->retryAfter);
        self::assertFalse($transport->send([])?->retryable);
        self::assertTrue((new HttpTransport('http://127.0.0.1:1', 'k', 'v'))->send([])?->retryable);
    }

    public function testReadsRetryAfterInBothFormsAndCapsIt(): void
    {
        $now = gmmktime(0, 0, 0, 1, 1, 2026);

        self::assertSame(30.0, HttpTransport::retryAfter('Thu, 01 Jan 2026 00:00:30 GMT', $now));
        self::assertSame(300.0, HttpTransport::retryAfter('99999', $now));
        self::assertSame(0.0, HttpTransport::retryAfter('soon', $now));
    }

    public function testTheWorkerAnnouncesDeliversOnTheIntervalAndAtTheEnd(): void
    {
        $ingest = new Ingest();
        $worker = WorkerDelivery::start(self::settings($ingest), null, 100);
        self::assertNotNull($worker);

        $ingest->waitFor(1);
        self::assertSame(['events' => []], $ingest->requests()[0]['body'] ?? null, 'the announcement');

        $worker->record(['toolName' => 'a']);
        $ingest->waitFor(2);
        self::assertSame('a', $ingest->requests()[1]['body']['events'][0]['toolName'] ?? null, 'within the interval');

        $worker->record(['toolName' => 'b']);
        $worker->stop(true);
        self::assertSame('b', $ingest->requests()[2]['body']['events'][0]['toolName'] ?? null, 'before the program ends');
    }

    public function testAWorkerLeftWithoutAFinalDeliveryDropsWhatItHeld(): void
    {
        $ingest = new Ingest();
        $worker = WorkerDelivery::start(self::settings($ingest, ['flushInterval' => 3600]), null, 100);
        $ingest->waitFor(1);
        $worker?->record(['toolName' => 'a']);
        $worker?->stop(false);

        self::assertCount(1, $ingest->requests());
    }

    public function testTheWorkerHandsDiagnosticsToTheCallback(): void
    {
        $ingest = new Ingest();
        $ingest->answer(401);
        $said = [];
        $worker = WorkerDelivery::start(self::settings($ingest, ['diagnosticsToParent' => true]), static function (string $message) use (&$said): void {
            $said[] = $message;
        }, 100);
        $ingest->waitFor(1);
        $worker?->record(['toolName' => 'a']);
        $worker?->stop(true);

        self::assertCount(1, $ingest->requests(), 'nothing after a refused key');
        self::assertCount(1, $said);
        self::assertStringContainsString('rejected the API key (HTTP 401)', $said[0]);
    }
}
