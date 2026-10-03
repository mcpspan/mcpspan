# frozen_string_literal: true

require "test_helper"

class ReporterTest < Minitest::Test
  def event(name)
    McpSpan::Event.new(id: name, tool_name: name, duration_ms: 1.0, success: true, client_type: "unknown",
                       timestamp: "2026-01-01T00:00:00.000Z",)
  end

  def reporter(capture, batch: 100, queue: 100, on_diagnostic: nil)
    McpSpan::Reporter.new(endpoint: "test", send: capture, flush_interval: 3600, max_batch_size: batch,
                          max_queue_size: queue, debug: false, on_diagnostic: on_diagnostic,)
  end

  def failure(status, retryable, retry_after = 0)
    McpSpan::Failure.new(message: status.to_s, status: status, retryable: retryable, retry_after: retry_after)
  end

  def names(capture)
    capture.batches.map { |batch| batch.map { |event| event[:toolName] } }
  end

  def test_backoff_doubles_to_a_ceiling_within_the_spread
    assert_in_delta(0.5, McpSpan::Reporter.backoff(1, 0.0))
    assert_in_delta(1.0, McpSpan::Reporter.backoff(1, 1.0))
    assert_in_delta(4.0, McpSpan::Reporter.backoff(3, 1.0))
    assert_in_delta(60.0, McpSpan::Reporter.backoff(30, 1.0))
  end

  def test_splits_what_is_queued_into_batches
    capture = Capture.new
    subject = reporter(capture, batch: 2)
    %w[a b c].each { |name| subject.record(event(name)) }
    subject.flush

    assert_equal([%w[a b], ["c"]], names(capture))
  end

  def test_keeps_a_batch_that_may_succeed_later_and_waits_before_trying_again
    capture = Capture.new([failure(503, true)])
    subject = reporter(capture)
    subject.record(event("a"))
    subject.flush
    subject.send(:deliver, force: false)

    assert_equal(1, capture.batches.size, "not tried again within the backoff")
    subject.flush

    assert_equal([["a"], ["a"]], names(capture))
  end

  def test_waits_as_long_as_retry_after_asks
    subject = reporter(Capture.new([failure(429, true, 120)]))
    subject.record(event("a"))
    subject.flush
    wait = subject.instance_variable_get(:@next_attempt) - Process.clock_gettime(Process::CLOCK_MONOTONIC)

    assert_operator(wait, :>, 119)
  end

  def test_drops_a_batch_refused_as_malformed_and_carries_on
    capture = Capture.new([failure(400, false)])
    subject = reporter(capture)
    subject.record(event("a"))
    subject.flush
    subject.record(event("b"))
    subject.flush

    assert_equal([["a"], ["b"]], names(capture))
  end

  def test_a_full_queue_drops_the_oldest
    capture = Capture.new
    subject = reporter(capture, queue: 2)
    %w[a b c].each { |name| subject.record(event(name)) }
    subject.flush

    assert_equal([%w[b c]], names(capture))
  end

  def test_announces_then_sends_a_full_batch_without_waiting_for_the_interval
    capture = Capture.new
    subject = reporter(capture, batch: 2)
    subject.start
    subject.record(event("a"))
    subject.record(event("b"))
    deadline = Time.now + 5
    sleep(0.01) while capture.batches.size < 2 && Time.now < deadline

    assert_equal([[], %w[a b]], names(capture))
  ensure
    subject.stop
  end

  def test_a_refused_key_stops_for_good_and_says_so_once_even_without_debug
    [401, 403].each do |status|
      said = []
      capture = Capture.new([failure(status, false)])
      subject = reporter(capture, on_diagnostic: ->(message) { said << message })
      subject.start
      deadline = Time.now + 5
      sleep(0.01) while said.empty? && Time.now < deadline
      subject.record(event("a"))
      subject.stop

      assert_equal([[]], names(capture), "nothing after a #{status}")
      assert_equal(1, said.size)
      assert_includes(said.first, "rejected the API key (HTTP #{status})")
    end
  end
end
