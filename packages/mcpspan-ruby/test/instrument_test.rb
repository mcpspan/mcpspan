# frozen_string_literal: true

require "test_helper"

class InstrumentTest < Minitest::Test
  include McpSpanTest

  def test_the_gem_still_has_what_the_hooks_take_the_place_of
    assert(McpSpan::Instrumentation.hookable?, "MCP::Server no longer has #{McpSpan::Instrumentation::HOOKED}")
  end

  def test_records_every_kind_of_call
    capture(capture_parameter_names: true)
    session = connect(McpSpan.instrument(server))

    call(session, "search_flights", { destination: "LIS", passengers: 2 })
    call(session, "no_flights")
    answer = call(session, "book_flight")
    call(session, "search_flights", { destination: 7 })
    call(session, "search_flights", { destination: "LIS" })
    call(session, "cancel_flight")
    events = delivered

    searches = events.select { |event| event[:toolName] == "search_flights" }
    assert_equal(true, searches[0][:success])
    assert_equal("claude-code", searches[0][:clientType])
    assert_equal("claude-code", searches[0][:clientName])
    assert_equal(McpSpan::VERSION, searches[0][:sdkVersion])
    assert_equal({ "destination" => "string", "passengers" => "number" }, searches[0][:parameters])
    refute(searches[0].key?(:errorSource))

    # Refused before the tool ran, invalid or missing, and without a message: it can quote what the agent sent.
    assert_equal(%w[arguments arguments], searches[1..].map { |event| event[:errorSource] })
    assert(searches[1..].none? { |event| event.key?(:errorMessage) })

    reported = @capture.only("no_flights")
    assert_equal("result", reported[:errorSource])
    assert_equal("No flights found", reported[:errorMessage])

    thrown = @capture.only("book_flight")
    assert_equal("exception", thrown[:errorSource])
    assert_equal("BookingError", thrown[:errorType])
    assert_equal("Seat map unavailable", thrown[:errorMessage])
    assert(answer[:error], "the client still gets its error")

    unknown = @capture.only("cancel_flight")
    assert_equal("unknown_tool", unknown[:errorSource])
    refute(unknown.key?(:errorMessage))

    # One connection, one session, ours.
    assert_equal(1, events.map { |event| event[:sessionId] }.uniq.size)
    assert_match(/\A\h{8}-\h{4}-4\h{3}-\h{4}-\h{12}\z/, events.first[:sessionId])
  end

  def test_measures_tools_added_after_instrumenting
    capture
    instrumented = McpSpan.instrument(server([]))
    instrumented.define_tool(name: "late") { |**| MCP::Tool::Response.new([{ type: "text", text: "ok" }]) }
    call(connect(instrumented), "late")
    delivered

    assert_equal(true, @capture.only("late")[:success])
  end

  def test_leaves_out_an_excluded_tool_even_when_it_is_refused
    capture
    McpSpan.exclude(HealthCheck)
    McpSpan.exclude("defined_later")
    instrumented = McpSpan.instrument(server)
    instrumented.define_tool(name: "defined_later") { |**| MCP::Tool::Response.new([]) }
    session = connect(instrumented)
    call(session, "health_check")
    call(session, "health_check", { unexpected: [1] })
    call(session, "defined_later")
    call(session, "search_flights", { destination: "LIS", passengers: 1 })

    assert_equal(["search_flights"], delivered.map { |event| event[:toolName] })
  ensure
    HealthCheck.remove_instance_variable(:@__mcpspan_excluded)
  end

  def test_separate_connections_are_separate_sessions
    capture
    instrumented = McpSpan.instrument(server)
    call(connect(instrumented, "cursor"), "search_flights", { destination: "LIS", passengers: 1 })
    call(connect(instrumented, "chatgpt"), "search_flights", { destination: "LIS", passengers: 1 })
    events = delivered

    assert_equal(%w[cursor chatgpt], events.map { |event| event[:clientType] })
    refute_equal(events[0][:sessionId], events[1][:sessionId])
  end

  def test_the_servers_own_version_and_the_clients
    capture
    session = connect(McpSpan.instrument(server), "cursor")
    call(session, "search_flights", { destination: "LIS", passengers: 1 })
    call(session, "no_such_tool")
    events = delivered

    assert_equal([["1.4.0", "1.0"]] * 2, events.map { |event| [event[:serverVersion], event[:clientVersion]] })
  end

  def test_a_server_version_set_for_the_sdk_wins_over_the_servers_own
    capture(server_version: "abc123")
    call(connect(McpSpan.instrument(server)), "search_flights", { destination: "LIS", passengers: 1 })

    assert_equal("abc123", delivered[0][:serverVersion])
  end

  def test_a_tracked_tool_counts_once_and_alone_has_no_session
    capture
    tracked = Class.new(MCP::Tool) do
      tool_name "tracked"
      def self.call(**) = MCP::Tool::Response.new([{ type: "text", text: "ok" }])
    end
    McpSpan.track(tracked)
    call(connect(McpSpan.instrument(server([tracked]))), "tracked")
    call(connect(server([tracked])), "tracked")
    events = delivered

    assert_equal(2, events.size)
    assert(events[0][:sessionId])
    refute(events[1].key?(:sessionId))
  end

  def test_instrumenting_twice_counts_once
    capture
    instrumented = McpSpan.instrument(McpSpan.instrument(server))
    call(connect(instrumented), "no_flights")

    assert_equal(1, delivered.size)
  end

  def test_without_a_key_does_nothing
    McpSpan::Collector.configure({}, sender: ->(_) { flunk("nothing is sent without a key") })
    instrumented = McpSpan.instrument(server)
    session = connect(instrumented)

    refute(McpSpan.collecting?)
    assert_equal("LIS for 1", call(session, "search_flights", { destination: "LIS", passengers: 1 })
      .dig(:result, :content, 0, :text),)
    assert(call(session, "book_flight")[:error])
  end
end

# Measuring must never be why a call fails, whatever goes wrong inside it.
class NeverBreaksTest < Minitest::Test
  include McpSpanTest

  def test_a_library_that_cannot_load_does_not_reach_the_call
    capture
    session = connect(McpSpan.instrument(server))
    replacing(McpSpan::Instrumentation, :session_id, ->(_) { raise LoadError, "cannot load such file -- rack" }) do
      answer = call(session, "search_flights", { destination: "LIS", passengers: 1 })

      assert_equal("LIS for 1", answer.dig(:result, :content, 0, :text))
    end
  end

  def test_recording_that_fails_leaves_the_answer_alone
    capture
    session = connect(McpSpan.instrument(server))
    replacing(McpSpan::Collector, :record, ->(*, **) { raise NoMethodError, "broken" }) do
      assert_equal("LIS for 1", call(session, "search_flights", { destination: "LIS", passengers: 1 })
        .dig(:result, :content, 0, :text),)
      assert(call(session, "book_flight")[:error])
    end
  end
end
