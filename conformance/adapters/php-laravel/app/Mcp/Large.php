<?php

declare(strict_types=1);

namespace App\Mcp;

use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Tool;

final class Large extends Tool
{
    protected string $name = 'large';

    public function handle(Request $request): Response
    {
        return Response::text(str_repeat('x', 100_000));
    }
}
