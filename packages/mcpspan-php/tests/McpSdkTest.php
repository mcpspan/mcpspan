<?php

declare(strict_types=1);

namespace McpSpan\Tests;

use Mcp\Schema\Content\TextContent;
use Mcp\Schema\Result\CallToolResult;
use Mcp\Server;
use Mcp\Server\Builder;
use Mcp\Server\Session\InMemorySessionStore;
use Mcp\Server\Transport\StreamableHttpTransport;
use McpSpan\Exclude;
use McpSpan\McpSdk;
use McpSpan\McpSdk\Internals;
use McpSpan\McpSpan;
use McpSpan\Tests\Support\UsesCapture;
use Nyholm\Psr7\Factory\Psr17Factory;
use PHPUnit\Framework\TestCase;
use Psr\Http\Message\ResponseInterface;

final class BookingError extends \RuntimeException
{
}

final class HealthCheck
{
    #[Exclude]
    public function __invoke(): string
    {
        return 'ok';
    }
}

/** The SDK on a real mcp/sdk server, over its streamable HTTP transport. */
final class McpSdkTest extends TestCase
{
    use UsesCapture;

    private Psr17Factory $http;
    private InMemorySessionStore $sessions;

    protected function setUp(): void
    {
        $this->http = new Psr17Factory();
        $this->sessions = new InMemorySessionStore();
    }

    private function builder(): Builder
    {
        return Server::builder()
            ->setServerInfo('flights', '1.4.0')
            ->setSession($this->sessions)
            ->addTool(static fn (string $destination, float $passengers): string => "{$destination} for {$passengers}", 'search_flights')
            ->addTool(static fn (): CallToolResult => CallToolResult::error([new TextContent('No flights found')]), 'no_flights')
            ->addTool(static function (): string {
                throw new BookingError('Seat map unavailable');
            }, 'book_flight')
            ->addTool(HealthCheck::class, 'health_check');
    }

    /**
     * @param array<string, mixed>  $body
     * @param array<string, string> $headers
     */
    private function post(Server $server, array $body, array $headers = []): ResponseInterface
    {
        $request = $this->http->createServerRequest('POST', 'http://localhost/mcp')
            ->withHeader('Content-Type', 'application/json')
            ->withHeader('Accept', 'application/json, text/event-stream')
            ->withBody($this->http->createStream(json_encode($body, \JSON_THROW_ON_ERROR)));
        foreach ($headers as $name => $value) {
            $request = $request->withHeader($name, $value);
        }

        return $server->run(new StreamableHttpTransport($request, $this->http, $this->http));
    }

    /** A connection: the handshake, as the named client. Returns the transport's session identifier. */
    private function connect(Server $server, string $client): string
    {
        $response = $this->post($server, ['jsonrpc' => '2.0', 'id' => 0, 'method' => 'initialize', 'params' => [
            'protocolVersion' => '2025-11-25', 'capabilities' => new \stdClass(), 'clientInfo' => ['name' => $client, 'version' => '1'],
        ]]);
        $session = $response->getHeaderLine('Mcp-Session-Id');
        $this->post($server, ['jsonrpc' => '2.0', 'method' => 'notifications/initialized'], ['Mcp-Session-Id' => $session]);

        return $session;
    }

    /** @param array<string, mixed> $arguments */
    private function call(Server $server, string $session, string $tool, array $arguments = []): void
    {
        $this->post($server, ['jsonrpc' => '2.0', 'id' => 1, 'method' => 'tools/call', 'params' => [
            'name' => $tool, 'arguments' => (object) $arguments,
        ]], ['Mcp-Session-Id' => $session]);
    }

    public function testRecordsEveryKindOfCall(): void
    {
        $this->capture(['captureParameterNames' => true]);
        $server = McpSdk::instrument($this->builder())->build();
        $session = $this->connect($server, 'claude-code');

        $this->call($server, $session, 'search_flights', ['destination' => 'LIS', 'passengers' => 2]);
        $this->call($server, $session, 'no_flights');
        $this->call($server, $session, 'book_flight');
        $this->call($server, $session, 'search_flights', ['destination' => 7]);
        $this->call($server, $session, 'cancel_flight');
        $events = $this->delivered();

        $searches = array_values(array_filter($events, static fn (array $event): bool => 'search_flights' === $event['toolName']));
        self::assertTrue($searches[0]['success']);
        self::assertSame('claude-code', $searches[0]['clientType']);
        self::assertSame(McpSpan::VERSION, $searches[0]['sdkVersion']);
        self::assertEquals((object) ['destination' => 'string', 'passengers' => 'number'], $searches[0]['parameters']);
        self::assertSame('arguments', $searches[1]['errorSource']);
        self::assertArrayNotHasKey('errorMessage', $searches[1], 'a refusal carries no message');

        self::assertSame(['result', 'No flights found'], [$this->capture->only('no_flights')['errorSource'], $this->capture->only('no_flights')['errorMessage']]);

        $thrown = $this->capture->only('book_flight');
        self::assertSame(['exception', 'BookingError', 'Seat map unavailable'], [$thrown['errorSource'], $thrown['errorType'], $thrown['errorMessage']]);

        self::assertSame('unknown_tool', $this->capture->only('cancel_flight')['errorSource']);

        // One connection, one session, ours and not the transport's.
        $sessions = array_unique(array_column($events, 'sessionId'));
        self::assertCount(1, $sessions);
        self::assertNotSame($session, $sessions[0]);
    }

    /** @param array<string, mixed> $params */
    private function request(Server $server, string $session, string $method, array $params): string
    {
        return (string) $this->post($server, ['jsonrpc' => '2.0', 'id' => 1, 'method' => $method, 'params' => $params], ['Mcp-Session-Id' => $session])->getBody();
    }

    public function testRecordsReadsAndGetsByWhatTheServerRegistered(): void
    {
        $this->capture(['captureParameterNames' => true]);
        $server = McpSdk::instrument($this->builder())
            ->addResource(static fn (): string => 'rates', 'flights://rates', 'rates')
            ->addResource(static function (): string {
                throw new BookingError('Report not ready');
            }, 'flights://report', 'report')
            ->addResourceTemplate(static fn (string $reference, string $seat): string => 'held', 'bookings://{reference}/seats/{seat}', 'booking')
            ->addPrompt(static fn (string $destination): array => [['role' => 'user', 'content' => "Plan {$destination}"]], 'plan_trip')
            ->addPrompt(static function (): string {
                throw new BookingError('No template');
            }, 'broken')
            ->build();
        $session = $this->connect($server, 'claude-code');

        $this->request($server, $session, 'resources/read', ['uri' => 'flights://rates']);
        $this->request($server, $session, 'resources/read', ['uri' => 'flights://report']);
        self::assertStringContainsString('held', $this->request($server, $session, 'resources/read', ['uri' => 'bookings://lovelace/seats/12A']));
        $this->request($server, $session, 'resources/read', ['uri' => 'file:///home/lovelace/contract.pdf']);
        $this->request($server, $session, 'prompts/get', ['name' => 'plan_trip', 'arguments' => ['destination' => 'LIS']]);
        $this->request($server, $session, 'prompts/get', ['name' => 'plan_trip', 'arguments' => new \stdClass()]);
        $this->request($server, $session, 'prompts/get', ['name' => 'broken']);
        $this->request($server, $session, 'prompts/get', ['name' => 'missing']);
        $this->call($server, $session, 'no_flights');
        $events = $this->delivered();

        self::assertSame([
            ['resource', 'flights://rates', null],
            ['resource', 'flights://report', 'exception'],
            ['resource', 'bookings://{reference}/seats/{seat}', null],
            ['resource', 'file://', 'unknown_resource'],
            ['prompt', 'plan_trip', null],
            ['prompt', 'plan_trip', 'arguments'],
            ['prompt', 'broken', 'exception'],
            ['prompt', 'missing', 'unknown_prompt'],
            [null, 'no_flights', 'result'],
        ], array_map(static fn (array $event): array => [$event['kind'] ?? null, $event['toolName'], $event['errorSource'] ?? null], $events));

        // The template's variables by name, never what the client put in them.
        self::assertEquals((object) ['reference' => 'string', 'seat' => 'string'], $events[2]['parameters']);
        self::assertEquals((object) ['destination' => 'string'], $events[4]['parameters']);
        self::assertStringNotContainsString('lovelace', json_encode($events, \JSON_THROW_ON_ERROR));
        self::assertArrayNotHasKey('errorMessage', $events[5], 'a refusal carries no message');

        self::assertSame(['BookingError', 'Report not ready'], [$events[1]['errorType'], $events[1]['errorMessage']]);
        self::assertSame('BookingError', $events[6]['errorType']);

        // Every kind of call, one session.
        self::assertCount(1, array_unique(array_column($events, 'sessionId')));
    }

    public function testListsAreNotRecorded(): void
    {
        $this->capture();
        $server = McpSdk::instrument($this->builder())
            ->addResource(static fn (): string => 'rates', 'flights://rates', 'rates')
            ->addPrompt(static fn (): array => [['role' => 'user', 'content' => 'Plan']], 'plan_trip')
            ->build();
        $session = $this->connect($server, 'cursor');
        foreach (['resources/list', 'resources/templates/list', 'prompts/list'] as $method) {
            $this->request($server, $session, $method, []);
        }

        self::assertSame([], $this->delivered());
    }

    public function testSeparateConnectionsAreSeparateSessions(): void
    {
        $this->capture();
        $server = McpSdk::instrument($this->builder())->build();
        $this->call($server, $this->connect($server, 'cursor'), 'search_flights', ['destination' => 'LIS', 'passengers' => 1]);
        $this->call($server, $this->connect($server, 'chatgpt'), 'search_flights', ['destination' => 'LIS', 'passengers' => 1]);
        $events = $this->delivered();

        self::assertSame(['cursor', 'chatgpt'], array_column($events, 'clientType'));
        self::assertNotSame($events[0]['sessionId'], $events[1]['sessionId']);
    }

    public function testOn20260728TheCallNamesItsClientAndHasNoSession(): void
    {
        $this->capture();
        $server = McpSdk::instrument($this->builder())->build();
        for ($i = 0; $i < 2; ++$i) {
            $response = $this->post($server, ['jsonrpc' => '2.0', 'id' => 1, 'method' => 'tools/call', 'params' => [
                'name' => 'no_flights', 'arguments' => new \stdClass(), '_meta' => [
                    'io.modelcontextprotocol/protocolVersion' => '2026-07-28',
                    'io.modelcontextprotocol/clientCapabilities' => new \stdClass(),
                    'io.modelcontextprotocol/clientInfo' => ['name' => 'claude-code', 'version' => '1'],
                ],
            ]], ['MCP-Protocol-Version' => '2026-07-28', 'Mcp-Method' => 'tools/call', 'Mcp-Name' => 'no_flights']);
            self::assertSame(200, $response->getStatusCode(), (string) $response->getBody());
        }
        $events = $this->delivered();

        self::assertSame(['claude-code', 'claude-code'], array_column($events, 'clientName'));
        self::assertSame([], array_column($events, 'sessionId'));
    }

    public function testRecordsTheServersOwnVersionAndTheClients(): void
    {
        $this->capture();
        $server = McpSdk::instrument($this->builder())->build();
        $session = $this->connect($server, 'cursor');
        $this->call($server, $session, 'no_flights');
        $this->call($server, $session, 'cancel_flight');
        $events = $this->delivered();

        self::assertSame([['1.4.0', '1'], ['1.4.0', '1']], array_map(static fn (array $event): array => [$event['serverVersion'] ?? null, $event['clientVersion'] ?? null], $events));
    }

    public function testAServerVersionSetForTheSdkWinsAndNoneGivenIsNone(): void
    {
        $this->capture(['serverVersion' => 'abc123']);
        $server = McpSdk::instrument($this->builder())->build();
        $this->call($server, $this->connect($server, 'cursor'), 'no_flights');
        self::assertSame('abc123', $this->delivered()[0]['serverVersion'] ?? null);

        // Without setServerInfo the SDK announces a placeholder, `dev`, which is not the server's.
        $this->capture();
        $server = McpSdk::instrument(Server::builder()->setSession($this->sessions)->addTool(static fn (): string => 'ok', 'ok'))->build();
        $this->call($server, $this->connect($server, 'cursor'), 'ok');
        self::assertArrayNotHasKey('serverVersion', $this->delivered()[0]);
    }

    public function testMeasuresToolsAddedAfterInstrumentingAndLeavesOutExcludedOnes(): void
    {
        $this->capture();
        $builder = McpSdk::instrument($this->builder())
            ->addTool(static fn (): string => 'late', 'late')
            ->addTool(static fn (): string => 'ok', McpSpan::exclude('named_out'));
        $server = $builder->build();
        $session = $this->connect($server, 'cursor');
        $this->call($server, $session, 'late');
        $this->call($server, $session, 'health_check');
        $this->call($server, $session, 'health_check', ['unexpected' => 1]);
        $this->call($server, $session, 'named_out');

        self::assertSame(['late'], array_column($this->delivered(), 'toolName'));
    }

    public function testInstrumentingTwiceCountsOnce(): void
    {
        $this->capture();
        $server = McpSdk::instrument(McpSdk::instrument($this->builder()))->build();
        $this->call($server, $this->connect($server, 'cursor'), 'no_flights');

        self::assertCount(1, $this->delivered());
    }

    public function testTheSdkStillHasWhatTheIntegrationReads(): void
    {
        $builder = $this->builder();
        $builder->build();

        self::assertIsArray(Internals::parts($builder), 'Builder::$parts');
        foreach ([Server\Handler\Request\CallToolHandler::class, Server\Handler\Request\ReadResourceHandler::class, Server\Handler\Request\GetPromptHandler::class] as $class) {
            self::assertNotEmpty(array_filter(
                Internals::parts($builder)['requestHandlers'],
                static fn (object $handler): bool => $handler instanceof $class,
            ), $class);
        }
        self::assertInstanceOf(\Mcp\Capability\RegistryInterface::class, Internals::parts($builder)['registry'] ?? null);
        self::assertTrue((new \ReflectionClass(Builder::class))->hasProperty('referenceHandler'));
        self::assertTrue((new \ReflectionClass(Builder::class))->hasProperty('container'));
        self::assertTrue((new \ReflectionClass(Builder::class))->hasProperty('serverInfo'));
    }

    public function testWithoutAKeyTheSdkAnswersAlone(): void
    {
        \McpSpan\Core\Collector::useSender(static fn (array $events) => throw new \LogicException('nothing is sent without a key'));
        McpSpan::configure();
        $server = McpSdk::instrument($this->builder())->build();
        $session = $this->connect($server, 'cursor');

        self::assertFalse(McpSpan::collecting());
        $response = $this->post($server, ['jsonrpc' => '2.0', 'id' => 1, 'method' => 'tools/call', 'params' => [
            'name' => 'search_flights', 'arguments' => ['destination' => 'LIS', 'passengers' => 1],
        ]], ['Mcp-Session-Id' => $session]);
        self::assertStringContainsString('LIS for 1', (string) $response->getBody());
    }
}
