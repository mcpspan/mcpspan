<?php

declare(strict_types=1);

namespace McpSpan\Core;

/**
 * Batches events and delivers them, with the same rules in every mcpspan SDK: a bounded queue, a widening gap
 * after failures, Retry-After honoured, and a refused key the end of it.
 *
 * It runs no loop of its own. The delivery worker drives it on a timer; a PHP request drives it at its end.
 *
 * @internal
 */
final class Reporter
{
    /** @var list<array<string, mixed>> */
    private array $queue = [];
    private int $dropped = 0;
    private int $failures = 0;
    private ?float $nextAttempt = null;
    private float $lastDelivery;
    private bool $rejected = false;

    /**
     * @param \Closure(list<array<string, mixed>>): ?Failure $send
     * @param \Closure(string, bool): void                   $say  a diagnostic, and whether it is said even without debug
     */
    public function __construct(
        private readonly string $endpoint,
        private readonly \Closure $send,
        private readonly float $flushInterval,
        private readonly int $maxBatchSize,
        private readonly int $maxQueueSize,
        private readonly \Closure $say,
    ) {
        $this->lastDelivery = self::now();
    }

    /** The wait after the n-th consecutive failure: doubling to a ceiling, spread over its second half. */
    public static function backoff(int $failures, ?float $random = null): float
    {
        $ceiling = min(60.0, 2 ** min($failures - 1, 16));
        $random ??= mt_rand() / mt_getrandmax();

        return $ceiling / 2 + $random * $ceiling / 2;
    }

    public function rejected(): bool
    {
        return $this->rejected;
    }

    /** Sends one empty batch to say the server is there (contract, 3.4). Not retried. */
    public function announce(): void
    {
        $failure = ($this->send)([]);
        if (null === $failure) {
            return;
        }
        if (401 === $failure->status || 403 === $failure->status) {
            $this->reject($failure->status);

            return;
        }
        ($this->say)("mcpspan: could not announce this server to {$this->endpoint} ({$failure->message}). "
            .'Events will still be delivered once it answers.', false);
    }

    /** @param array<string, mixed> $event */
    public function record(array $event): void
    {
        if ($this->rejected) {
            return;
        }
        if (\count($this->queue) >= $this->maxQueueSize) {
            array_shift($this->queue);
            ++$this->dropped;
        }
        $this->queue[] = $event;
    }

    /** Whether a delivery is due: a full batch, or a partial one that has waited the interval, and no retry pending. */
    public function due(): bool
    {
        if ($this->rejected || [] === $this->queue) {
            return false;
        }
        $now = self::now();
        if (null !== $this->nextAttempt && $now < $this->nextAttempt) {
            return false;
        }

        return \count($this->queue) >= $this->maxBatchSize || $now - $this->lastDelivery >= $this->flushInterval;
    }

    /** Seconds until a delivery could next be due, for a caller that sleeps until then. */
    public function wait(): float
    {
        $now = self::now();
        $deadline = null !== $this->nextAttempt ? $this->nextAttempt : $this->lastDelivery + $this->flushInterval;

        return max(0.0, $deadline - $now);
    }

    /** Delivers what is queued. Forced, it ignores any retry delay: the last chance these events get. */
    public function deliver(bool $force = false): void
    {
        if ($this->rejected || (!$force && null !== $this->nextAttempt && self::now() < $this->nextAttempt)) {
            return;
        }
        $this->lastDelivery = self::now();
        if ($this->dropped > 0) {
            ($this->say)("mcpspan: discarded {$this->dropped} events, the queue was full", false);
            $this->dropped = 0;
        }
        while ([] !== $this->queue && !$this->rejected) {
            $batch = \array_slice($this->queue, 0, $this->maxBatchSize);
            $this->queue = \array_slice($this->queue, \count($batch));
            $failure = ($this->send)($batch);
            if (null !== $failure) {
                $this->failed($batch, $failure);

                return;
            }
            $this->failures = 0;
            $this->nextAttempt = null;
        }
    }

    /** @param list<array<string, mixed>> $batch */
    private function failed(array $batch, Failure $failure): void
    {
        if (401 === $failure->status || 403 === $failure->status) {
            $this->reject($failure->status);

            return;
        }
        if ($failure->retryable) {
            $this->queue = [...$batch, ...$this->queue];
            while (\count($this->queue) > $this->maxQueueSize) {
                array_shift($this->queue);
                ++$this->dropped;
            }
        } else {
            // Refused the same way every time: dropped, and collecting goes on.
            ($this->say)('mcpspan: dropped '.\count($batch)." events, rejected as {$failure->status}", false);
        }
        ++$this->failures;
        // The longer of our own backoff and what the API asked for.
        $this->nextAttempt = self::now() + max(self::backoff($this->failures), $failure->retryAfter);
        ($this->say)("mcpspan: delivery failed ({$failure->message}), attempt {$this->failures}", false);
    }

    /**
     * Gives up on a key the endpoint refused, and says so once even with diagnostics off: a silent SDK collecting
     * nothing because of a mistyped key is the worst way to spend an afternoon.
     */
    private function reject(int $status): void
    {
        if ($this->rejected) {
            return;
        }
        $this->rejected = true;
        $this->queue = [];
        ($this->say)("mcpspan: the ingest endpoint rejected the API key (HTTP {$status}). "
            .'Telemetry is now disabled for this process.', true);
    }

    private static function now(): float
    {
        return hrtime(true) / 1e9;
    }
}
