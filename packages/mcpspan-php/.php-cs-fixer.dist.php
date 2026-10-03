<?php

declare(strict_types=1);

$finder = PhpCsFixer\Finder::create()->in([__DIR__.'/src', __DIR__.'/tests', __DIR__.'/config']);

return (new PhpCsFixer\Config())
    ->setRiskyAllowed(true)
    ->setRules([
        // The style of the official PHP MCP SDK, which is Symfony's.
        '@Symfony' => true,
        '@Symfony:risky' => true,
        '@PHP8x2Migration' => true,
        'declare_strict_types' => true,
    ])
    ->setFinder($finder);
