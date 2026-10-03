<?php

declare(strict_types=1);

/*
 * The delivery worker: a small PHP process a long-running server starts, so that delivering never happens on the
 * server's own time. It reads its settings, then one event per line, from standard input, and batches and delivers
 * them as every mcpspan SDK does. A line {"final":true} asks for a last delivery; end of input ends it.
 *
 * It never writes to the MCP server's standard output, which it does not have: diagnostics go to standard error,
 * which it shares with the server, or back up its own output when the server wants them for a callback.
 */

namespace McpSpan\Core;

require_once __DIR__.'/Failure.php';
require_once __DIR__.'/Event.php';
require_once __DIR__.'/HttpTransport.php';
require_once __DIR__.'/Reporter.php';

$settings = json_decode((string) fgets(\STDIN), true);
if (!\is_array($settings)) {
    exit(0);
}

$debug = (bool) $settings['debug'];
$toParent = (bool) $settings['diagnosticsToParent'];
$say = static function (string $message, bool $always) use ($debug, $toParent): void {
    if (!$always && !$debug) {
        return;
    }
    if ($toParent) {
        @fwrite(\STDOUT, $message."\n");
    } else {
        @fwrite(\STDERR, $message.\PHP_EOL);
    }
};

$transport = new HttpTransport((string) $settings['endpoint'], (string) $settings['apiKey'], (string) $settings['version']);
$reporter = new Reporter(
    (string) $settings['endpoint'],
    $transport->send(...),
    (float) $settings['flushInterval'],
    (int) $settings['maxBatchSize'],
    (int) $settings['maxQueueSize'],
    $say(...),
);

$reporter->announce();

stream_set_blocking(\STDIN, false);
$buffer = '';
$final = false;

while (true) {
    $read = [\STDIN];
    $write = $except = null;
    $wait = $reporter->due() ? 0.0 : min($reporter->wait(), 1.0);
    $ready = @stream_select($read, $write, $except, (int) $wait, (int) (($wait - (int) $wait) * 1e6));

    if (false === $ready) {
        // A platform without select on pipes: poll instead.
        usleep(50_000);
    }

    $chunk = fread(\STDIN, 65536);
    if (\is_string($chunk) && '' !== $chunk) {
        $buffer .= $chunk;
        while (false !== ($end = strpos($buffer, "\n"))) {
            $line = substr($buffer, 0, $end);
            $buffer = substr($buffer, $end + 1);
            $message = json_decode($line, true);
            if (!\is_array($message)) {
                continue;
            }
            if (true === ($message['final'] ?? null)) {
                $final = true;
            } elseif (\is_array($message['event'] ?? null)) {
                $reporter->record($message['event']);
            }
        }
    }

    if (feof(\STDIN)) {
        break;
    }

    if ($reporter->due()) {
        $reporter->deliver();
    }
}

if ($final) {
    $reporter->deliver(true);
}
