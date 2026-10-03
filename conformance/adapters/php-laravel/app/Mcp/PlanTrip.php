<?php

declare(strict_types=1);

namespace App\Mcp;

use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Prompt;
use Laravel\Mcp\Server\Prompts\Argument;

final class PlanTrip extends Prompt
{
    protected string $name = 'plan_trip';

    public function arguments(): array
    {
        return [new Argument('destination', 'Where to', required: true)];
    }

    public function handle(Request $request): Response
    {
        // Laravel leaves a prompt to check its own arguments, as it does a tool.
        $trip = $request->validate(['destination' => 'required|string']);

        return Response::text("Plan a trip to {$trip['destination']}");
    }
}
