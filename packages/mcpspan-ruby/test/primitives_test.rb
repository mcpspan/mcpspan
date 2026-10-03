# frozen_string_literal: true

require "test_helper"

class ReportUnavailable < StandardError; end

class PrimitivesTest < Minitest::Test
  include McpSpanTest

  RATES = MCP::Resource.define(uri: "flights://rates", name: "rates") do |**|
    MCP::Resource::TextContents.new(uri: "flights://rates", text: "rates", mime_type: "text/plain")
  end
  REPORT = MCP::Resource.define(uri: "flights://report", name: "report") do |**|
    raise ReportUnavailable, "Report not ready"
  end
  BOOKING = MCP::ResourceTemplate.define(
    uri_template: "bookings://{reference}/seats/{seat}", name: "booking",
  ) do |reference:, seat:, **|
    MCP::Resource::TextContents.new(uri: "bookings://#{reference}/seats/#{seat}", text: "held", mime_type: "text/plain")
  end
  PLAN_TRIP = MCP::Prompt.define(
    name: "plan_trip",
    arguments: [MCP::Prompt::Argument.new(name: "destination", required: true)],
  ) do |args, **|
    MCP::Prompt::Result.new(messages: [
                              MCP::Prompt::Message.new(role: "user",
                                                       content: MCP::Content::Text.new("Plan #{args[:destination]}"),),
                            ])
  end
  BROKEN = MCP::Prompt.define(name: "broken") { |*, **| raise ReportUnavailable, "No template" }

  def test_the_gem_still_has_what_the_hooks_take_the_place_of
    assert(McpSpan::Primitives.hookable?, "MCP::Server no longer has #{McpSpan::Primitives::HOOKED}")
  end

  def test_records_reads_and_gets_by_what_the_server_registered
    capture(capture_parameter_names: true)
    session = connect(McpSpan.instrument(primitives_server))

    read(session, "flights://rates")
    assert(read(session, "flights://report")[:error], "the client still gets its error")
    assert_equal("held", read(session, "bookings://lovelace/seats/12A").dig(:result, :contents, 0, :text))
    read(session, "file:///home/lovelace/contract.pdf")
    get(session, "plan_trip", { destination: "LIS" })
    get(session, "plan_trip")
    get(session, "broken")
    get(session, "missing")
    call(session, "search_flights", { destination: "LIS", passengers: 1 })
    events = delivered

    assert_equal(
      [
        %w[resource flights://rates] + [nil],
        %w[resource flights://report exception],
        ["resource", "bookings://{reference}/seats/{seat}", nil],
        %w[resource file:// unknown_resource],
        ["prompt", "plan_trip", nil],
        %w[prompt plan_trip arguments],
        %w[prompt broken exception],
        %w[prompt missing unknown_prompt],
        [nil, "search_flights", nil],
      ],
      events.map { |event| [event[:kind], event[:toolName], event[:errorSource]] },
    )

    # The template's variables by name, never what the client put in them.
    assert_equal({ "reference" => "string", "seat" => "string" }, events[2][:parameters])
    assert_equal({ "destination" => "string" }, events[4][:parameters])
    refute_includes(events.to_s, "lovelace")

    assert_equal(["ReportUnavailable", "Report not ready"], events[1].values_at(:errorType, :errorMessage))
    assert_equal("ReportUnavailable", events[6][:errorType])

    # Every kind of call, one session.
    assert_equal(1, events.map { |event| event[:sessionId] }.uniq.size)
  end

  def test_names_a_read_by_the_developers_records_when_the_developer_answers_it
    capture
    server = MCP::Server.new(
      name: "flights",
      resources: [MCP::Resource.new(uri: "flights://rates", name: "rates")],
      resource_templates: [MCP::ResourceTemplate.new(uri_template: "trips://{id}", name: "trip")],
    )
    server.resources_read_handler { |params| [{ uri: params[:uri], text: "ok" }] }
    session = connect(McpSpan.instrument(server))

    read(session, "flights://rates")
    read(session, "trips://ada")
    read(session, "db://customers/4412")

    assert_equal(%w[flights://rates trips://{id} db://], delivered.map { |event| event[:toolName] })
  end

  def test_lists_are_not_recorded
    capture
    session = connect(McpSpan.instrument(primitives_server))
    %w[resources/list resources/templates/list prompts/list].each do |method|
      session.handle({ jsonrpc: "2.0", id: method, method: method, params: {} })
    end

    assert_empty(delivered)
  end

  def test_recording_that_fails_leaves_the_answer_alone
    capture
    session = connect(McpSpan.instrument(primitives_server))
    replacing(McpSpan::Collector, :record, ->(*, **) { raise NoMethodError, "broken" }) do
      assert_equal("rates", read(session, "flights://rates").dig(:result, :contents, 0, :text))
      assert(get(session, "plan_trip", { destination: "LIS" })[:result])
      assert(get(session, "plan_trip")[:error])
    end
  end

  private

  def primitives_server
    MCP::Server.new(
      name: "flights",
      tools: [SearchFlights],
      resources: [RATES, REPORT],
      resource_templates: [BOOKING],
      prompts: [PLAN_TRIP, BROKEN],
    )
  end

  def read(session, uri)
    request(session, "resources/read", { uri: uri })
  end

  def get(session, name, arguments = {})
    request(session, "prompts/get", { name: name, arguments: arguments })
  end

  def request(session, method, params)
    @id = (@id || 0) + 1
    session.handle({ jsonrpc: "2.0", id: @id, method: method, params: params })
  end
end
