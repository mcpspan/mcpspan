<?php

declare(strict_types=1);

use App\Mcp\ConformanceServer;
use Laravel\Mcp\Facades\Mcp;

Mcp::local('conformance', ConformanceServer::class);
