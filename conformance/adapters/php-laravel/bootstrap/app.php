<?php

declare(strict_types=1);

use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;

// The smallest application Laravel's own skeleton makes, with its exception handling: a tool's exception is
// reported through it.
return Application::configure(basePath: dirname(__DIR__))
    ->withExceptions(static function (Exceptions $exceptions): void {
    })
    ->create();
