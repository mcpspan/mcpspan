<?php

declare(strict_types=1);

namespace McpSpan\Core;

/**
 * Delivers from the server's own process, for PHP that handles one request per process, as under PHP-FPM: what a
 * request recorded is sent as it ends, after the response has gone to the client where the framework has let it
 * go (Laravel and Symfony call fastcgi_finish_request before their shutdown functions run). A long-running server
 * that cannot start a worker lands here too, and then also delivers when a batch is due, on a tool call's time.
 *
 * @internal
 */
final class InlineDelivery implements Delivery
{
    public function __construct(private readonly Reporter $reporter, private readonly bool $longRunning)
    {
    }

    public function record(array $event): void
    {
        $this->reporter->record($event);
        if ($this->longRunning && $this->reporter->due()) {
            $this->reporter->deliver();
        }
    }

    public function stop(bool $final): void
    {
        if ($final) {
            $this->reporter->deliver(true);
        }
    }
}
