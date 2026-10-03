<?php

declare(strict_types=1);

namespace McpSpan\Core;

/**
 * Hands events to a delivery worker process, for a server that runs for a long time: a stdio server, or a worker
 * under Octane or RoadRunner. Writing to the worker never blocks; what does not fit in the pipe waits in memory,
 * bounded like the queue, until the next event or the end.
 *
 * @internal
 */
final class WorkerDelivery implements Delivery
{
    /** How long the end of the program waits for the worker to deliver, at most. */
    private const STOP_TIMEOUT = HttpTransport::TIMEOUT + 2;

    /** @var resource */
    private $process;
    /** @var resource */
    private $input;
    /** @var resource|null */
    private $output;
    private string $pending = '';
    private int $pendingEvents = 0;
    private int $pid;

    /** @param array<string, mixed> $settings */
    private function __construct(array $settings, private readonly ?\Closure $onDiagnostic, private readonly int $maxPending)
    {
        $output = null === $onDiagnostic ? ['file', '\\' === \DIRECTORY_SEPARATOR ? 'NUL' : '/dev/null', 'w'] : ['pipe', 'w'];
        $process = proc_open([\PHP_BINARY, __DIR__.'/worker.php'], [0 => ['pipe', 'r'], 1 => $output, 2 => \STDERR], $pipes);
        if (!\is_resource($process)) {
            throw new \RuntimeException('could not start the delivery worker');
        }
        $this->process = $process;
        $this->input = $pipes[0];
        $this->output = $pipes[1] ?? null;
        $this->pid = getmypid() ?: 0;
        // The settings, the key among them, go through the pipe: a command line is readable by anyone who can list
        // processes.
        fwrite($this->input, json_encode($settings, \JSON_UNESCAPED_SLASHES)."\n");
        stream_set_blocking($this->input, false);
        if (null !== $this->output) {
            stream_set_blocking($this->output, false);
        }
    }

    /**
     * A worker, or null where one cannot be started: outside the command line, or where proc_open is disabled.
     *
     * @param array<string, mixed> $settings
     */
    public static function start(array $settings, ?\Closure $onDiagnostic, int $maxPending): ?self
    {
        if (\PHP_SAPI !== 'cli' || !\function_exists('proc_open') || !\defined('STDERR')) {
            return null;
        }
        try {
            return new self($settings, $onDiagnostic, $maxPending);
        } catch (\Throwable) {
            return null;
        }
    }

    public function record(array $event): void
    {
        // A forked child shares the pipe, and must not write into the parent's stream.
        if ((getmypid() ?: 0) !== $this->pid) {
            return;
        }
        if ($this->pendingEvents >= $this->maxPending) {
            return;
        }
        $this->pending .= json_encode(['event' => $event], \JSON_UNESCAPED_SLASHES | \JSON_INVALID_UTF8_SUBSTITUTE | \JSON_PRESERVE_ZERO_FRACTION)."\n";
        ++$this->pendingEvents;
        $this->write();
        $this->relay();
    }

    public function stop(bool $final): void
    {
        if ((getmypid() ?: 0) !== $this->pid) {
            return;
        }
        if ($final) {
            $this->pending .= "{\"final\":true}\n";
        }
        $deadline = hrtime(true) / 1e9 + self::STOP_TIMEOUT;
        stream_set_blocking($this->input, true);
        stream_set_timeout($this->input, self::STOP_TIMEOUT);
        $this->write();
        @fclose($this->input);

        // The worker delivers and exits; wait for it, for a few seconds at most, so a program that ends does not end
        // before its last events are sent.
        while (hrtime(true) / 1e9 < $deadline) {
            $this->relay();
            $status = proc_get_status($this->process);
            if (!$status['running']) {
                break;
            }
            usleep(20_000);
        }
        $this->relay();
    }

    private function write(): void
    {
        while ('' !== $this->pending) {
            $written = @fwrite($this->input, $this->pending);
            if (false === $written || 0 === $written) {
                return;
            }
            $sent = substr_count(substr($this->pending, 0, $written), "\n");
            $this->pendingEvents = max(0, $this->pendingEvents - $sent);
            $this->pending = substr($this->pending, $written);
        }
    }

    /** Passes the worker's diagnostics to the developer's callback. */
    private function relay(): void
    {
        if (null === $this->output || null === $this->onDiagnostic) {
            return;
        }
        while (\is_string($line = fgets($this->output)) && '' !== $line) {
            try {
                ($this->onDiagnostic)(rtrim($line, "\n"));
            } catch (\Throwable) {
            }
        }
    }
}
