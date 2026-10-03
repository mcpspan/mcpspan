# frozen_string_literal: true

require "test_helper"

class TextTest < Minitest::Test
  # The contract's table as cases, shared by every SDK's tests (conformance/client-types.json).
  def test_detects_the_contract_table
    table = JSON.parse(File.read(File.expand_path("../../../conformance/client-types.json", __dir__)))["cases"]

    assert_operator(table.size, :>, 10)
    table.each { |name, type| assert_equal(type, McpSpan::Text.client_type(name), name.inspect) }
  end

  def test_truncate_marks_a_cut_and_keeps_characters_whole
    assert_equal("abc", McpSpan::Text.truncate("abc", 5))
    assert_equal("żó...", McpSpan::Text.truncate("żółwie", 5))
  end

  def test_describes_parameters_by_name_and_json_type_only
    described = McpSpan::Text.describe_parameters({ a: "x", b: 1.5, c: true, d: nil, e: [1], f: { g: 1 } })

    assert_equal({ "a" => "string", "b" => "number", "c" => "boolean", "d" => "null", "e" => "array", "f" => "object" },
                 described,)
    assert_nil(McpSpan::Text.describe_parameters({}))
    assert_equal(50, McpSpan::Text.describe_parameters((1..60).to_h { |i| ["p#{i}", i] }).size)
  end
end
