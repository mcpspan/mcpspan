<?php

declare(strict_types=1);

namespace McpSpan\Tests\Support;

use McpSpan\Core\Collector;
use McpSpan\McpSpan;

/** Configures the SDK to deliver into a Capture, from the test's own process, and stops it after each test. */
trait UsesCapture
{
    private Capture $capture;

    /** @param array<string, mixed> $settings */
    private function capture(array $settings = []): Capture
    {
        $this->capture = new Capture();
        Collector::useSender($this->capture->__invoke(...));
        Collector::assumeLongRunning(false);
        McpSpan::configure(['apiKey' => 'mk_test', 'flushInterval' => 3600, ...$settings]);

        return $this->capture;
    }

    /** @return list<array<string, mixed>> */
    private function delivered(): array
    {
        McpSpan::shutdown();

        return $this->capture->events();
    }

    protected function tearDown(): void
    {
        McpSpan::shutdown();
        McpSpan::forgetExclusions();
        Collector::useSender(null);
        Collector::assumeLongRunning(null);
        parent::tearDown();
    }
}
