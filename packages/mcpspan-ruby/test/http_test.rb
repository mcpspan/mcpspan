# frozen_string_literal: true

require "test_helper"
require "json"
require "rack"
require "rack/mock"

# Sessions over streamable HTTP, where a connection is a transport session or nothing at all.
class HttpTest < Minitest::Test
  include McpSpanTest

  ACCEPT = "application/json, text/event-stream"

  def post(app, body, headers = {})
    env = Rack::MockRequest.env_for(
      "http://localhost/mcp",
      method: "POST", input: JSON.generate(body),
      "CONTENT_TYPE" => "application/json", "HTTP_ACCEPT" => ACCEPT, "HTTP_HOST" => "localhost", **headers,
    )
    app.call(env)
  end

  def handshake(app, client)
    status, headers, = post(app, {
      jsonrpc: "2.0", id: 0, method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: client, version: "1" } },
    })
    assert_equal(200, status)
    id = headers["mcp-session-id"]
    post(app, { jsonrpc: "2.0", method: "notifications/initialized" }, "HTTP_MCP_SESSION_ID" => id) if id
    id
  end

  def call_over(app, session_id)
    post(app, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "no_flights", arguments: {} } },
         session_id ? { "HTTP_MCP_SESSION_ID" => session_id } : {},)
  end

  def test_a_transport_session_is_one_session_of_ours
    capture
    app = MCP::Server::Transports::StreamableHTTPTransport.new(McpSpan.instrument(server), enable_json_response: true)
    first = handshake(app, "cursor")
    second = handshake(app, "claude-code")
    2.times { call_over(app, first) }
    call_over(app, second)
    events = delivered
    sessions = events.map { |event| event[:sessionId] }

    assert_equal(3, sessions.compact.size)
    assert_equal(sessions[0], sessions[1])
    refute_equal(sessions[0], sessions[2])
    refute_includes(sessions, first, "never the transport's own identifier")
    assert_equal(%w[cursor cursor claude-code], events.map { |event| event[:clientName] })
  end

  def test_a_stateless_endpoint_has_no_sessions
    capture
    app = MCP::Server::Transports::StreamableHTTPTransport.new(McpSpan.instrument(server), stateless: true,
                                                                                           enable_json_response: true,)
    2.times { call_over(app, nil) }
    events = delivered

    assert_equal(2, events.size)
    assert(events.none? { |event| event.key?(:sessionId) })
  end

  def test_on_2026_07_28_the_call_names_its_client_and_has_no_session
    capture
    app = MCP::Server::Transports::StreamableHTTPTransport.new(McpSpan.instrument(server))
    meta = {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
      "io.modelcontextprotocol/clientInfo": { name: "claude-code", version: "1" },
    }
    2.times do
      body = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "no_flights", arguments: {}, _meta: meta } }
      headers = { "HTTP_MCP_PROTOCOL_VERSION" => "2026-07-28", "HTTP_MCP_METHOD" => "tools/call",
                  "HTTP_MCP_NAME" => "no_flights", }
      status, = post(app, body, headers)
      assert_equal(200, status)
    end
    events = delivered

    assert_equal(%w[claude-code claude-code], events.map { |event| event[:clientName] })
    assert(events.none? { |event| event.key?(:sessionId) })
  end
end
