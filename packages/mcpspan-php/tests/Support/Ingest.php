<?php

declare(strict_types=1);

namespace McpSpan\Tests\Support;

/** The ingest API on a local port, served by PHP's built-in server. */
final class Ingest
{
    public readonly string $endpoint;
    private readonly string $dir;
    /** @var resource */
    private $process;

    public function __construct()
    {
        $this->dir = sys_get_temp_dir().'/mcpspan-ingest-'.bin2hex(random_bytes(4));
        mkdir($this->dir);
        $port = self::freePort();
        $this->endpoint = "http://127.0.0.1:{$port}";
        $this->process = proc_open(
            [\PHP_BINARY, '-S', "127.0.0.1:{$port}", __DIR__.'/ingest.php'],
            [0 => ['file', '/dev/null', 'r'], 1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']],
            $pipes,
            null,
            ['INGEST_DIR' => $this->dir],
        );
        $deadline = microtime(true) + 5;
        while (microtime(true) < $deadline && false === @fsockopen('127.0.0.1', $port)) {
            usleep(20_000);
        }
    }

    public function __destruct()
    {
        proc_terminate($this->process);
        proc_close($this->process);
        array_map('unlink', glob("{$this->dir}/*") ?: []);
        @rmdir($this->dir);
    }

    /** Answers the next request with this status, and a Retry-After if given. */
    public function answer(int $status, ?string $retryAfter = null): void
    {
        file_put_contents("{$this->dir}/answers", trim($status.' '.($retryAfter ?? ''))."\n", \FILE_APPEND);
    }

    /** @return list<array<string, mixed>> */
    public function requests(): array
    {
        $lines = is_file("{$this->dir}/received") ? file("{$this->dir}/received", \FILE_IGNORE_NEW_LINES) : [];

        return array_map(static fn (string $line): array => json_decode($line, true), $lines ?: []);
    }

    /** Waits until this many requests have arrived, for a few seconds at most. */
    public function waitFor(int $count, float $seconds = 10): void
    {
        $deadline = microtime(true) + $seconds;
        while (\count($this->requests()) < $count && microtime(true) < $deadline) {
            usleep(20_000);
        }
    }

    private static function freePort(): int
    {
        $socket = stream_socket_server('tcp://127.0.0.1:0');
        $name = stream_socket_get_name($socket, false);
        fclose($socket);

        return (int) substr((string) $name, strrpos((string) $name, ':') + 1);
    }
}
