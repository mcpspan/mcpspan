# frozen_string_literal: true

require "minitest/autorun"
require "mcp"
require "mcpspan"

# Captures what would be delivered, in place of the ingest API.
class Capture
  attr_reader :batches

  def initialize(answers = [])
    @batches = []
    @answers = answers.dup
    @lock = Mutex.new
  end

  def call(events)
    @lock.synchronize do
      @batches << events.map(&:to_h)
      @answers.shift
    end
  end

  # Every event, the announcement aside.
  def events
    @lock.synchronize { @batches.flatten }
  end

  def only(name)
    matching = events.select { |event| event[:toolName] == name }
    raise "expected one event for #{name}, got #{matching.inspect}" unless matching.size == 1

    matching.first
  end
end

class BookingError < StandardError; end

class SearchFlights < MCP::Tool
  tool_name "search_flights"
  input_schema(
    properties: { destination: { type: "string" }, passengers: { type: "number" } },
    required: %w[destination passengers],
  )

  def self.call(destination:, passengers:, **)
    MCP::Tool::Response.new([{ type: "text", text: "#{destination} for #{passengers}" }])
  end
end

class NoFlights < MCP::Tool
  tool_name "no_flights"

  def self.call(**)
    MCP::Tool::Response.new([{ type: "text", text: "No flights found" }], error: true)
  end
end

class BookFlight < MCP::Tool
  tool_name "book_flight"

  def self.call(**)
    raise BookingError, "Seat map unavailable"
  end
end

class HealthCheck < MCP::Tool
  tool_name "health_check"

  def self.call(**)
    MCP::Tool::Response.new([{ type: "text", text: "ok" }])
  end
end

# A transport that goes nowhere: the tests hand requests to a session directly.
class NullTransport < MCP::Transport
  def send_response(_response); end
  def send_notification(*); end
end

module McpSpanTest
  # Replaces a module method for the length of the block.
  def replacing(owner, name, replacement)
    original = owner.method(name)
    owner.define_singleton_method(name, &replacement)
    yield
  ensure
    owner.define_singleton_method(name, original)
  end

  # Configures the SDK to deliver into a Capture, and stops it after each test.
  def capture(answers = [], **settings)
    @capture = Capture.new(answers)
    McpSpan::Collector.configure({ api_key: "mk_test", flush_interval: 3600, **settings }, sender: @capture)
    @capture
  end

  # Delivers what is queued and returns the events.
  def delivered
    McpSpan.shutdown
    @capture.events
  end

  def teardown
    McpSpan.shutdown
    McpSpan.excluded_names.clear
    super
  end

  def server(tools = [SearchFlights, NoFlights, BookFlight, HealthCheck])
    MCP::Server.new(name: "flights", version: "1.4.0", tools: tools)
  end

  # A connection to the server, with the handshake done as the named client.
  def connect(server, client = "claude-code")
    session = MCP::ServerSession.new(server: server, transport: NullTransport.new(server))
    session.handle({
      jsonrpc: "2.0", id: 0, method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: client, version: "1.0" } },
    })
    session.handle({ jsonrpc: "2.0", method: "notifications/initialized" })
    session
  end

  def call(session, name, arguments = {})
    @id = (@id || 0) + 1
    session.handle({ jsonrpc: "2.0", id: @id, method: "tools/call", params: { name: name, arguments: arguments } })
  end
end
