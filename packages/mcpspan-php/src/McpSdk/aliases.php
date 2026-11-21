<?php

declare(strict_types=1);

/*
 * The classes of mcp/sdk that 0.10 moved, under one name for the integration, whichever version is installed:
 * McpSpan\McpSdk\Sdk\RegistryInterface is Mcp\Capability\RegistryInterface on 0.9 and
 * Mcp\Server\Capability\RegistryInterface on 0.10.
 *
 * An autoloader, so nothing is loaded until the integration asks, and only names under McpSpan\McpSdk\Sdk are ever
 * defined: nothing in the SDK's own namespace changes, for the SDK or for anybody else. It runs after Composer's own,
 * an authoritative class map included.
 *
 * The first name asked for defines them all, because `instanceof` loads nothing: it would call an object of the SDK's
 * not an instance of an alias that was never loaded.
 */

spl_autoload_register(static function (string $class): void {
    $prefix = 'McpSpan\\McpSdk\\Sdk\\';
    if (!str_starts_with($class, $prefix)) {
        return;
    }

    $registry = ['ElementReference', 'PromptReference', 'ReferenceHandler', 'ReferenceHandlerInterface',
        'ResourceReference', 'ResourceTemplateReference', 'ToolReference'];
    $names = [
        'RegistryInterface' => ['Mcp\\Server\\Capability\\RegistryInterface', 'Mcp\\Capability\\RegistryInterface'],
        'MissingRequiredClientCapabilityException' => [
            'Mcp\\Server\\Exception\\MissingRequiredClientCapabilityException',
            'Mcp\\Exception\\MissingRequiredClientCapabilityException',
        ],
        'RequestMeta' => ['Mcp\\Schema\\RequestMeta', 'Mcp\\Server\\Stateless\\RequestMeta'],
        'Server' => ['Mcp\\Server\\Server', 'Mcp\\Server'],
    ];
    foreach ($registry as $name) {
        $names[$name] = ['Mcp\\Server\\Capability\\Registry\\'.$name, 'Mcp\\Capability\\Registry\\'.$name];
    }

    foreach ($names as $name => $candidates) {
        if (class_exists($prefix.$name, false) || interface_exists($prefix.$name, false)) {
            continue;
        }
        foreach ($candidates as $candidate) {
            if (class_exists($candidate) || interface_exists($candidate)) {
                class_alias($candidate, $prefix.$name);
                break;
            }
        }
    }
});
