<?php

declare(strict_types=1);

namespace App\Mcp;

use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Resource;

final class ConfigResource extends Resource
{
    protected string $uri = 'config://app';

    public function handle(): Response
    {
        return Response::text('ok');
    }
}
