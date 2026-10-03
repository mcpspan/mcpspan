<?php

declare(strict_types=1);

namespace McpSpan\McpSdk;

use Mcp\Schema\Implementation;
use Mcp\Server\Builder;
use Mcp\Server\Session\SessionInterface;
use Mcp\Server\Stateless\RequestMeta;
use McpSpan\Core\Event;

/**
 * Who a request came from, and on which connection: one per instrumented server, so its tool calls, reads and
 * prompt gets share a session.
 *
 * @internal
 */
final class Connections
{
    /** Connections remembered. Past it the oldest is forgotten. */
    private const MAX_SESSIONS = 1_000;

    /** @var array<string, string> the SDK's session identifier, to ours */
    private array $sessions = [];

    /**
     * The client's name and version: from the request itself on 2026-07-28, else from its connection's handshake.
     *
     * @return array{?string, ?string}
     */
    public static function client(SessionInterface $session): array
    {
        $meta = $session->get(RequestMeta::class);
        if ($meta instanceof RequestMeta) {
            return [$meta->clientInfo?->name, $meta->clientInfo?->version];
        }
        $info = $session->get('client_info');
        $name = \is_array($info) ? ($info['name'] ?? null) : null;
        $version = \is_array($info) ? ($info['version'] ?? null) : null;

        return [\is_string($name) ? $name : null, \is_string($version) ? $version : null];
    }

    /** The version the server gives itself, `setServerInfo('flights', '1.4.0')`; none when it was never set. */
    public static function serverVersion(Builder $builder): ?string
    {
        $info = Internals::read($builder, 'serverInfo');

        return $info instanceof Implementation ? $info->version : null;
    }

    /**
     * Our identifier for the connection, or null on 2026-07-28, which has no sessions: the SDK makes a throwaway
     * one for each request there. It is random, and never derived from the SDK's own, which travels in HTTP headers.
     */
    public function session(SessionInterface $session): ?string
    {
        if ($session->get(RequestMeta::class) instanceof RequestMeta) {
            return null;
        }
        $key = (string) $session->getId();
        if (!isset($this->sessions[$key])) {
            if (\count($this->sessions) >= self::MAX_SESSIONS) {
                array_shift($this->sessions);
            }
            $this->sessions[$key] = Event::uuid();
        }

        return $this->sessions[$key];
    }
}
