# frozen_string_literal: true

require "test_helper"

class DefinitionsTest < Minitest::Test
  SHARED = JSON.parse(File.read(File.expand_path("../../../conformance/definition-hashes.json", __dir__)))["cases"]

  def teardown
    McpSpan::Definitions.forget
  end

  def test_fingerprints_the_shared_cases_as_every_sdk_does
    SHARED.each { |entry| assert_equal(entry["hash"], McpSpan::Definitions.hash(entry["tool"]), entry["case"]) }
  end

  def test_keeps_the_latest_listed_fingerprint_of_each_tool
    McpSpan::Definitions.note([{ name: "a", description: "one" }, { name: "b" }])
    McpSpan::Definitions.note([{ name: "a", description: "two" }, { description: "nameless" }])
    McpSpan::Definitions.note(Object.new)

    assert_equal(McpSpan::Definitions.hash({ "name" => "a", "description" => "two" }), McpSpan::Definitions.of("a"))
    refute_nil(McpSpan::Definitions.of("b"))
    assert_nil(McpSpan::Definitions.of("c"))
  end
end
