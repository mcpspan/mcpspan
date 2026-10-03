# frozen_string_literal: true

require "test_helper"

# The README's Ruby samples, checked against the SDK: each parses, calls only what McpSpan has, and passes only
# settings it takes.
class ReadmeTest < Minitest::Test
  README = File.read(File.expand_path("../README.md", __dir__))
  SAMPLES = README.scan(/```ruby\n(.*?)```/m).flatten

  def test_every_sample_parses
    assert_operator(SAMPLES.size, :>=, 7)
    SAMPLES.each { |sample| RubyVM::InstructionSequence.compile(sample) }
  end

  def test_every_sample_calls_what_the_sdk_has
    SAMPLES.join("\n").scan(/McpSpan\.(\w+)/).flatten.uniq.each do |name|
      assert(McpSpan.respond_to?(name), "McpSpan.#{name} in the README")
    end
  end

  def test_every_setting_in_the_readme_is_one_the_sdk_takes
    passed = SAMPLES.join("\n").scan(/McpSpan\.(?:instrument|configure)\(server, (\w+):/).flatten
    listed = README.scan(/^\| `(\w+)` \|/).flatten

    assert_equal(McpSpan::Collector::SETTINGS.map(&:to_s).sort, listed.sort, "the Options table")
    passed.each { |name| assert_includes(McpSpan::Collector::SETTINGS, name.to_sym) }
  end
end
