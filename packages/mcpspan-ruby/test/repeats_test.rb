# frozen_string_literal: true

require "test_helper"

class RepeatsTest < Minitest::Test
  def teardown
    McpSpan::Repeats.forget
  end

  def test_tells_a_repeat_of_the_previous_call_to_the_tool_in_the_session_whatever_the_key_order
    refute(McpSpan::Repeats.note("s1", "search", { to: "WAW", n: 2 }))
    assert(McpSpan::Repeats.note("s1", "search", { "n" => 2, "to" => "WAW" }))
    refute(McpSpan::Repeats.note("s1", "search", { to: "KRK", n: 2 }))
    refute(McpSpan::Repeats.note("s1", "book", { to: "KRK", n: 2 }))
    refute(McpSpan::Repeats.note("s2", "search", { to: "KRK", n: 2 }))
    refute(McpSpan::Repeats.note("s1", "list", nil))
    assert(McpSpan::Repeats.note("s1", "list", {}))
  end

  def test_forgets_the_oldest_pairs_past_its_bound
    McpSpan::Repeats.note("first", "search", { to: "WAW" })
    McpSpan::Repeats::MAX_KEPT.times { |i| McpSpan::Repeats.note("s#{i}", "search", nil) }

    refute(McpSpan::Repeats.note("first", "search", { to: "WAW" }))
  end

  def test_knows_a_retry_answering_an_interim_question
    assert(McpSpan::Repeats.continues_earlier_call?({ name: "a", requestState: "x" }))
    assert(McpSpan::Repeats.continues_earlier_call?({ "inputResponses" => {} }))
    refute(McpSpan::Repeats.continues_earlier_call?({ name: "a" }))
    refute(McpSpan::Repeats.continues_earlier_call?(nil))
  end
end
