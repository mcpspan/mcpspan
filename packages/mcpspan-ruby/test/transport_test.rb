# frozen_string_literal: true

require "test_helper"
require "socket"

class TransportTest < Minitest::Test
  # Answers one request with the given status and headers, and keeps what it received.
  def serve(status, headers = {})
    server = TCPServer.new("127.0.0.1", 0)
    received = {}
    thread = Thread.new do
      client = server.accept
      received[:line] = client.gets
      while (line = client.gets) && line != "\r\n"
        name, value = line.split(":", 2)
        received[name.downcase] = value.strip
      end
      received[:body] = client.read(received["content-length"].to_i)
      extra = headers.map { |name, value| "#{name}: #{value}\r\n" }.join
      client.write("HTTP/1.1 #{status} X\r\nContent-Length: 0\r\n#{extra}Connection: close\r\n\r\n")
      client.close
    end
    [McpSpan::Transport.new("http://127.0.0.1:#{server.addr[1]}/", "mk_test"), received, thread]
  end

  def test_posts_a_batch_and_identifies_the_sdk
    transport, received, thread = serve(202)

    assert_nil(transport.call([]))
    thread.join

    assert_equal("POST /v1/events HTTP/1.1\r\n", received[:line])
    assert_equal("Bearer mk_test", received["authorization"])
    assert_equal("mcpspan/#{McpSpan::VERSION} (ruby)", received["user-agent"])
    assert_equal('{"events":[]}', received[:body])
  end

  def test_tells_what_may_be_retried
    transport, _, thread = serve(429, "Retry-After" => "12")
    failure = transport.call([])
    thread.join

    assert(failure.retryable)
    assert_equal(12, failure.retry_after)

    transport, _, thread = serve(400)
    failure = transport.call([])
    thread.join

    refute(failure.retryable)
  end

  def test_an_unreachable_endpoint_is_worth_retrying
    failure = McpSpan::Transport.new("http://127.0.0.1:1", "mk_test").call([])

    assert(failure.retryable)
    assert_nil(failure.status)
  end

  def test_reads_retry_after_in_both_forms_and_caps_it
    now = Time.utc(2026, 1, 1)

    assert_equal(30, McpSpan::Transport.retry_after("Thu, 01 Jan 2026 00:00:30 GMT", now: now).round)
    assert_equal(300, McpSpan::Transport.retry_after("99999", now: now))
    assert_equal(0, McpSpan::Transport.retry_after("soon", now: now))
  end
end
