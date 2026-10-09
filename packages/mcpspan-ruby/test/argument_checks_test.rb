# frozen_string_literal: true

require "test_helper"

class ArgumentChecksTest < Minitest::Test
  SHARED = JSON.parse(File.read(File.expand_path("../../../conformance/argument-checks.json", __dir__)))["cases"]

  def test_finds_the_shared_cases_as_every_sdk_does
    SHARED.each do |entry|
      assert_equal(entry["invalid"], McpSpan::ArgumentChecks.invalid(entry["schema"], entry["arguments"]),
                   entry["case"],)
    end
  end

  def test_finds_nothing_without_a_schema
    assert_equal([], McpSpan::ArgumentChecks.invalid(nil, { passengers: 2 }))
  end
end
