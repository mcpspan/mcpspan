<?php

declare(strict_types=1);

namespace McpSpan\McpSdk;

use Mcp\Schema\Implementation;
use Mcp\Server\Builder;
use Mcp\Server\Session\SessionInterface;
use Mcp\Server\Transport\StdioTransport;
use McpSpan\Core\Event;
use McpSpan\McpSdk\Sdk\RequestMeta;

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

    /** Whether this server answers over stdio; null until a 2026-07-28 request has said. */
    private ?bool $stdio = null;

    /** Ours for the one connection a server has over stdio on 2026-07-28. */
    private ?string $stdioSession = null;

    /**
     * The client's name and version: from the request itself on 2026-07-28, else from its connection's handshake.
     *
     * @return array{?string, ?string}
     */
    public static function client(SessionInterface $session): array
    {
        $meta = self::meta($session);
        if (null !== $meta) {
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
     * Our identifier for the connection. It is random, and never derived from the SDK's own, which travels in HTTP
     * headers.
     *
     * 2026-07-28 has no sessions: the SDK makes a throwaway one for each request, so over HTTP there is none. Over
     * stdio (mcp/sdk 0.9 on) the process is still one connection to one client, so it is one session, as it is on
     * every other SDK.
     */
    public function session(SessionInterface $session): ?string
    {
        if (null !== self::meta($session)) {
            return $this->overStdio() ? ($this->stdioSession ??= Event::uuid()) : null;
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

    /**
     * What a 2026-07-28 request says of itself, which the SDK keeps in the session under the class's own name: that
     * of the SDK, not the alias the integration knows it by.
     */
    private static function meta(SessionInterface $session): ?RequestMeta
    {
        if (!class_exists(RequestMeta::class)) {
            return null;
        }
        $meta = $session->get((new \ReflectionClass(RequestMeta::class))->getName());

        return $meta instanceof RequestMeta ? $meta : null;
    }

    /**
     * Whether the request being answered came through the SDK's stdio transport. The handlers are not told which
     * transport they serve, so the call stack is asked, once: a server runs on one transport.
     */
    private function overStdio(): bool
    {
        if (null === $this->stdio) {
            $this->stdio = false;
            foreach (debug_backtrace(\DEBUG_BACKTRACE_IGNORE_ARGS) as $frame) {
                if (isset($frame['class']) && is_a($frame['class'], StdioTransport::class, true)) {
                    $this->stdio = true;
                    break;
                }
            }
        }

        return $this->stdio;
    }
}
