<?php

declare(strict_types=1);

namespace App\Mcp;

use Illuminate\Contracts\JsonSchema\JsonSchema;
use McpSpan\Exclude;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Tool;

#[Exclude]
final class Excluded extends Tool
{
    protected string $name = 'excluded';

    public function handle(Request $request): Response
    {
        return Response::text('ok');
    }

    public function schema(JsonSchema $schema): array
    {
        return ['depth' => $schema->number()];
    }
}
