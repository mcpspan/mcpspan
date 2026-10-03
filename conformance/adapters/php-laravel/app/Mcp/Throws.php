<?php

declare(strict_types=1);

namespace App\Mcp;

use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Tool;

final class Throws extends Tool
{
    protected string $name = 'throws';

    public function handle(Request $request): Response
    {
        throw new ConformanceError('boom');
    }
}
