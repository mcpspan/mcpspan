<?php

declare(strict_types=1);

namespace McpSpan\Tests\Laravel;

use Illuminate\Contracts\JsonSchema\JsonSchema;
use Laravel\Mcp\Request;
use Laravel\Mcp\Response;
use Laravel\Mcp\Server;
use Laravel\Mcp\Server\Contracts\HasUriTemplate;
use Laravel\Mcp\Server\Prompt;
use Laravel\Mcp\Server\Prompts\Argument;
use Laravel\Mcp\Server\Resource;
use Laravel\Mcp\Server\Tool;
use Laravel\Mcp\Server\Transport\StdioTransport;
use Laravel\Mcp\Support\UriTemplate;
use McpSpan\Exclude;

final class BookingError extends \RuntimeException
{
}

final class SearchFlights extends Tool
{
    protected string $name = 'search_flights';

    public function handle(Request $request): Response
    {
        $search = $request->validate(['destination' => 'required|string', 'passengers' => 'required|numeric']);

        return Response::text("{$search['destination']} for {$search['passengers']}");
    }

    public function schema(JsonSchema $schema): array
    {
        return ['destination' => $schema->string()->required(), 'passengers' => $schema->number()->required()];
    }
}

final class NoFlights extends Tool
{
    protected string $name = 'no_flights';

    public function handle(Request $request): Response
    {
        return Response::error('No flights found');
    }
}

final class BookFlight extends Tool
{
    protected string $name = 'book_flight';

    public function handle(Request $request): Response
    {
        throw new BookingError('Seat map unavailable');
    }
}

final class StreamFlights extends Tool
{
    protected string $name = 'stream_flights';

    /** @return \Generator<Response> */
    public function handle(Request $request): \Generator
    {
        yield Response::notification('progress', ['step' => 1]);

        throw new BookingError('Stream broke');
    }
}

#[Exclude]
final class HealthCheck extends Tool
{
    protected string $name = 'health_check';

    public function handle(Request $request): Response
    {
        return Response::text('ok');
    }
}

final class Rates extends Resource
{
    protected string $uri = 'flights://rates';

    public function handle(): Response
    {
        return Response::text('rates');
    }
}

final class Report extends Resource
{
    protected string $uri = 'flights://report';

    public function handle(): Response
    {
        throw new BookingError('Report not ready');
    }
}

final class Booking extends Resource implements HasUriTemplate
{
    public function uriTemplate(): UriTemplate
    {
        return new UriTemplate('bookings://{reference}/seats/{seat}');
    }

    public function handle(Request $request): Response
    {
        return Response::text('held');
    }
}

final class PlanTrip extends Prompt
{
    protected string $name = 'plan_trip';

    public function arguments(): array
    {
        return [new Argument('destination', 'Where to', required: true)];
    }

    public function handle(Request $request): Response
    {
        $trip = $request->validate(['destination' => 'required|string']);

        return Response::text("Plan {$trip['destination']}");
    }
}

final class BrokenPrompt extends Prompt
{
    protected string $name = 'broken';

    public function handle(): Response
    {
        throw new BookingError('No template');
    }
}

final class Flights extends Server
{
    protected string $version = '1.4.0';

    protected array $tools = [SearchFlights::class, NoFlights::class, BookFlight::class, StreamFlights::class, HealthCheck::class];

    protected array $resources = [Rates::class, Report::class, Booking::class];

    protected array $prompts = [PlanTrip::class, BrokenPrompt::class];
}

/** Laravel's stdio transport, with what it would write kept rather than written to standard output. */
final class QuietStdio extends StdioTransport
{
    /** @var list<string> */
    public array $sent = [];

    public function send(string $message): void
    {
        $this->sent[] = $message;
    }
}
