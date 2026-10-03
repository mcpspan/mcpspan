# frozen_string_literal: true

require "test_helper"

class ConfigureTest < Minitest::Test
  include McpSpanTest

  def test_the_same_settings_again_change_nothing
    capture
    McpSpan::Collector.configure({ api_key: "mk_test", flush_interval: 3600 }, sender: @capture)
    McpSpan.shutdown

    assert_equal([[]], @capture.batches, "one announcement")
  end

  def test_a_malformed_setting_falls_back_to_its_default_and_says_so_when_asked
    said = []
    settings = McpSpan::Collector.send(:resolve, {
      flush_interval: -1, max_batch_size: "ten", max_queue_size: 0, colour: "blue",
      on_diagnostic: ->(message) { said << message },
    })

    assert_in_delta(5.0, settings[:flush_interval])
    assert_equal(100, settings[:max_batch_size])
    assert_equal(10_000, settings[:max_queue_size])
    assert(settings[:debug], "a callback implies debug")
    assert_equal(4, said.size, said.inspect)
  end

  def test_reads_the_key_and_the_endpoint_from_the_environment
    ENV["MCPSPAN_API_KEY"] = " mk_env "
    ENV["MCPSPAN_ENDPOINT"] = "http://mcpspan.internal"
    settings = McpSpan::Collector.send(:resolve, {})

    assert_equal("mk_env", settings[:api_key])
    assert_equal("http://mcpspan.internal", settings[:endpoint])
    assert_equal("", McpSpan::Collector.send(:resolve, { endpoint: " " })[:endpoint]
      .then { ENV.delete("MCPSPAN_ENDPOINT") && McpSpan::Collector.send(:resolve, {})[:endpoint] },)
  ensure
    ENV.delete("MCPSPAN_API_KEY")
    ENV.delete("MCPSPAN_ENDPOINT")
  end

  def test_nothing_raises_over_a_setting
    assert_nil(McpSpan.configure(api_key: 42, flush_interval: :soon, on_diagnostic: "not callable"))
  end

  def test_with_a_key_and_no_endpoint_collects_nothing_and_says_so_once
    ENV.delete("MCPSPAN_ENDPOINT")
    McpSpan::Collector.forget_no_endpoint_notice
    said = []
    settings = { api_key: "k", on_diagnostic: ->(message) { said << message } }

    McpSpan::Collector.configure(settings)
    McpSpan::Collector.configure(settings)

    refute_predicate(McpSpan::Collector, :collecting?)
    assert_equal([McpSpan::Collector::NO_ENDPOINT], said)
  end
end
