<?php

declare(strict_types=1);

namespace McpSpan\Tests\Laravel;

use Illuminate\Container\Container;
use Laravel\Mcp\Server\McpServiceProvider;
use McpSpan\LaravelMcp;
use McpSpan\LaravelMcp\McpSpanServiceProvider;
use McpSpan\McpSpan;
use McpSpan\Tests\Support\UsesCapture;
use Orchestra\Testbench\TestCase;

require_once __DIR__.'/Tools.php';

/** The SDK on Laravel MCP, instrumented by nothing but the package's service provider. */
final class LaravelMcpTest extends TestCase
{
    use UsesCapture {
        tearDown as stopCapturing;
    }

    protected function getPackageProviders($app): array
    {
        return [McpServiceProvider::class, McpSpanServiceProvider::class];
    }

    protected function tearDown(): void
    {
        LaravelMcp::forget();
        $this->stopCapturing();
    }

    private function stdioServer(QuietStdio $transport): Flights
    {
        $server = Container::getInstance()->make(Flights::class, ['transport' => $transport]);
        $server->start();

        return $server;
    }

    /** @param array<string, mixed> $params */
    private static function message(int $id, string $method, array $params): string
    {
        return json_encode(['jsonrpc' => '2.0', 'id' => $id, 'method' => $method, 'params' => $params], \JSON_THROW_ON_ERROR);
    }

    public function testRecordsEveryKindOfCallOnAStdioServer(): void
    {
        $this->capture(['captureParameterNames' => true]);
        $transport = new QuietStdio();
        $server = $this->stdioServer($transport);
        $server->handle(self::message(0, 'initialize', ['protocolVersion' => '2025-11-25', 'capabilities' => [], 'clientInfo' => ['name' => 'claude-code', 'version' => '1']]));

        $calls = [
            ['search_flights', ['destination' => 'LIS', 'passengers' => 2]],
            ['no_flights', []],
            ['book_flight', []],
            ['stream_flights', []],
            ['search_flights', ['destination' => 7]],
            ['cancel_flight', []],
            ['health_check', []],
        ];
        foreach ($calls as $i => [$name, $arguments]) {
            $server->handle(self::message($i + 1, 'tools/call', ['name' => $name, 'arguments' => (object) $arguments]));
        }
        $events = $this->delivered();

        // Every call answered, and the streamed tool's notification on its way.
        self::assertCount(\count($calls) + 2, $transport->sent);
        $searches = array_values(array_filter($events, static fn (array $event): bool => 'search_flights' === $event['toolName']));
        self::assertTrue($searches[0]['success']);
        self::assertSame('claude-code', $searches[0]['clientType']);
        self::assertEquals((object) ['destination' => 'string', 'passengers' => 'number'], $searches[0]['parameters']);
        // Laravel refuses arguments inside the tool, with a ValidationException.
        self::assertSame('arguments', $searches[1]['errorSource']);
        self::assertArrayNotHasKey('errorMessage', $searches[1]);

        self::assertSame(['result', 'No flights found'], [$this->capture->only('no_flights')['errorSource'], $this->capture->only('no_flights')['errorMessage']]);
        $thrown = $this->capture->only('book_flight');
        self::assertSame(['exception', 'BookingError', 'Seat map unavailable'], [$thrown['errorSource'], $thrown['errorType'], $thrown['errorMessage']]);
        $streamed = $this->capture->only('stream_flights');
        self::assertSame(['exception', 'BookingError', 'Stream broke'], [$streamed['errorSource'], $streamed['errorType'], $streamed['errorMessage']]);
        self::assertSame('unknown_tool', $this->capture->only('cancel_flight')['errorSource']);
        self::assertNotContains('health_check', array_column($events, 'toolName'));

        // The stdio process is the connection.
        self::assertCount(1, array_unique(array_column($events, 'sessionId')));
        self::assertNotNull($events[0]['sessionId'] ?? null);
    }

    public function testRecordsReadsAndGetsByWhatTheServerRegistered(): void
    {
        $this->capture(['captureParameterNames' => true]);
        $transport = new QuietStdio();
        $server = $this->stdioServer($transport);
        $server->handle(self::message(0, 'initialize', ['protocolVersion' => '2025-11-25', 'capabilities' => [], 'clientInfo' => ['name' => 'claude-code', 'version' => '1']]));

        $requests = [
            ['resources/read', ['uri' => 'flights://rates']],
            ['resources/read', ['uri' => 'flights://report']],
            ['resources/read', ['uri' => 'bookings://lovelace/seats/12A']],
            ['resources/read', ['uri' => 'file:///home/lovelace/contract.pdf']],
            ['prompts/get', ['name' => 'plan_trip', 'arguments' => ['destination' => 'LIS']]],
            ['prompts/get', ['name' => 'plan_trip', 'arguments' => new \stdClass()]],
            ['prompts/get', ['name' => 'broken']],
            ['prompts/get', ['name' => 'missing']],
            ['resources/list', []],
            ['prompts/list', []],
            ['tools/call', ['name' => 'no_flights', 'arguments' => new \stdClass()]],
        ];
        foreach ($requests as $i => [$method, $params]) {
            $server->handle(self::message($i + 1, $method, $params));
        }
        $events = $this->delivered();

        self::assertCount(\count($requests) + 1, $transport->sent, 'every request answered');
        self::assertStringContainsString('held', $transport->sent[3]);
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
        self::assertCount(1, array_unique(array_column($events, 'sessionId')));
    }

    public function testOverHttpACallHasNoSessionAndItsHandshakeIsAnotherRequest(): void
    {
        $this->capture();
        $response = Flights::tool(NoFlights::class);
        $response->assertHasErrors(['No flights found']);
        $events = $this->delivered();

        self::assertCount(1, $events);
        self::assertArrayNotHasKey('sessionId', $events[0]);
        self::assertSame('unknown', $events[0]['clientType']);
    }

    public function testOn20260728TheCallNamesItsClient(): void
    {
        $this->capture();
        $server = $this->stdioServer(new QuietStdio());
        $server->handle(self::message(1, 'tools/call', ['name' => 'no_flights', 'arguments' => new \stdClass(), '_meta' => [
            'io.modelcontextprotocol/protocolVersion' => '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities' => new \stdClass(),
            'io.modelcontextprotocol/clientInfo' => ['name' => 'cursor', 'version' => '1'],
        ]]));

        self::assertSame('cursor', $this->delivered()[0]['clientName'] ?? null);
    }

    public function testRecordsTheServersOwnVersionAndTheClients(): void
    {
        $this->capture();
        $server = $this->stdioServer(new QuietStdio());
        $server->handle(self::message(0, 'initialize', ['protocolVersion' => '2025-11-25', 'capabilities' => [], 'clientInfo' => ['name' => 'cursor', 'version' => '2.3.4']]));
        $server->handle(self::message(1, 'tools/call', ['name' => 'no_flights', 'arguments' => new \stdClass()]));
        $server->handle(self::message(2, 'prompts/get', ['name' => 'plan_trip', 'arguments' => ['destination' => 'LIS']]));

        $events = $this->delivered();
        self::assertSame([['1.4.0', '2.3.4'], ['1.4.0', '2.3.4']], array_map(static fn (array $event): array => [$event['serverVersion'] ?? null, $event['clientVersion'] ?? null], $events));
    }

    public function testAServerVersionSetForTheSdkWinsOverTheServersOwn(): void
    {
        $this->capture(['serverVersion' => 'abc123']);
        $server = $this->stdioServer(new QuietStdio());
        $server->handle(self::message(1, 'tools/call', ['name' => 'no_flights', 'arguments' => new \stdClass()]));

        self::assertSame('abc123', $this->delivered()[0]['serverVersion'] ?? null);
    }

    public function testWithoutAKeyLaravelAnswersAlone(): void
    {
        McpSpan::configure();
        $response = Flights::tool(SearchFlights::class, ['destination' => 'LIS', 'passengers' => 1]);

        self::assertFalse(McpSpan::collecting());
        $response->assertSee('LIS for 1');
    }
}
