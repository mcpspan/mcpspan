<?php

declare(strict_types=1);

// Settings for the MCP servers Laravel resolves. The key and the endpoint are read from the environment when these
// are left empty.
return [
    'apiKey' => env('MCPSPAN_API_KEY'),
    'endpoint' => env('MCPSPAN_ENDPOINT'),
    'captureParameterNames' => (bool) env('MCPSPAN_CAPTURE_PARAMETER_NAMES', false),
    'debug' => (bool) env('MCPSPAN_DEBUG', false),
];
