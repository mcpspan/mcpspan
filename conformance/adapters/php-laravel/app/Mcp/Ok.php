<?php

declare(strict_types=1);

namespace App\Mcp;

use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Tool;

final class Ok extends Tool
{
    protected string $name = 'ok';

    public function handle(Request $request): Response
    {
        return Response::text('ok');
    }
}
