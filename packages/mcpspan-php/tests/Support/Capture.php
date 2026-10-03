<?php

declare(strict_types=1);

namespace McpSpan\Tests\Support;

use McpSpan\Core\Failure;

/** Captures what would be delivered, in place of the ingest API, answering with the failures it is given. */
final class Capture
{
    /** @var list<list<array<string, mixed>>> */
    public array $batches = [];

    /** @param list<Failure|null> $answers */
    public function __construct(private array $answers = [])
    {
    }

    /** @param list<array<string, mixed>> $events */
    public function __invoke(array $events): ?Failure
    {
        $this->batches[] = $events;

        return array_shift($this->answers);
    }

    /** @return list<array<string, mixed>> every event, the announcement aside */
    public function events(): array
    {
        return array_merge(...$this->batches);
    }

    /** @return array<string, mixed> */
    public function only(string $tool): array
    {
        $matching = array_values(array_filter($this->events(), static fn (array $event): bool => $event['toolName'] === $tool));
        if (1 !== \count($matching)) {
            throw new \RuntimeException("expected one event for {$tool}, got ".json_encode($matching));
        }

        return $matching[0];
    }

    /** @return list<list<string>> */
    public function names(): array
    {
        return array_map(static fn (array $batch): array => array_map(static fn (array $event): string => $event['toolName'], $batch), $this->batches);
    }
}
