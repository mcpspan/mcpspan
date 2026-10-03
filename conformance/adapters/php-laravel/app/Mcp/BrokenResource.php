<?php

declare(strict_types=1);

namespace App\Mcp;

use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Resource;

final class BrokenResource extends Resource
{
    protected string $uri = 'broken://status';

    public function handle(): Response
    {
        throw new ConformanceError('boom');
    }
}
