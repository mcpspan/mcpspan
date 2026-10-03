<?php

declare(strict_types=1);

namespace App\Mcp;

use Laravel\Mcp\Response;
use Laravel\Mcp\Server\Prompt;

final class BrokenPrompt extends Prompt
{
    protected string $name = 'broken_prompt';

    public function handle(): Response
    {
        throw new ConformanceError('boom');
    }
}
