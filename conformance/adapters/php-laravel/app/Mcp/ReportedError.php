<?php

declare(strict_types=1);

namespace App\Mcp;

use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Tool;

final class ReportedError extends Tool
{
    protected string $name = 'reported_error';

    public function handle(Request $request): Response
    {
        return Response::error('No flights found');
    }
}
