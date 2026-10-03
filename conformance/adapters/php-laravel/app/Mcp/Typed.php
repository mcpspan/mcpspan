<?php

declare(strict_types=1);

namespace App\Mcp;

use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Tool;

final class Typed extends Tool
{
    protected string $name = 'typed';

    public function handle(Request $request): Response
    {
        $request->validate(['destination' => 'required|string', 'passengers' => 'required|numeric']);

        return Response::text('ok');
    }

    public function schema(JsonSchema $schema): array
    {
        return [
            'destination' => $schema->string()->required(),
            'passengers' => $schema->number()->required(),
        ];
    }
}
