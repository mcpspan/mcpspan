<?php

declare(strict_types=1);

// A stand-in for the ingest API under PHP's built-in server: keeps each request in a file, and answers with the
// statuses queued in another, then 202.

$dir = getenv('INGEST_DIR') ?: sys_get_temp_dir();
$answers = is_file("{$dir}/answers") ? array_filter(explode("\n", (string) file_get_contents("{$dir}/answers"))) : [];
$answer = array_shift($answers) ?? '202';
file_put_contents("{$dir}/answers", implode("\n", $answers));

[$status, $retryAfter] = array_pad(explode(' ', $answer), 2, null);
file_put_contents("{$dir}/received", json_encode([
    'path' => $_SERVER['REQUEST_URI'],
    'authorization' => $_SERVER['HTTP_AUTHORIZATION'] ?? null,
    'userAgent' => $_SERVER['HTTP_USER_AGENT'] ?? null,
    'body' => json_decode((string) file_get_contents('php://input'), true),
])."\n", \FILE_APPEND);

http_response_code((int) $status);
if (null !== $retryAfter) {
    header("Retry-After: {$retryAfter}");
}
echo '{}';
