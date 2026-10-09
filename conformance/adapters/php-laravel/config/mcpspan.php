<?php

declare(strict_types=1);

// The package's configuration, as `php artisan vendor:publish --tag=mcpspan-config` publishes it, with the suite's
// delivery interval and parameter recording. The key and the endpoint come from the environment.
return [
    'captureParameterNames' => '1' === env('CONFORMANCE_CAPTURE_PARAMETERS'),
    'captureErrorMessages' => '0' !== env('CONFORMANCE_CAPTURE_ERROR_MESSAGES'),
    'flushInterval' => ((int) env('CONFORMANCE_FLUSH_MS', 200)) / 1000,
];
