# frozen_string_literal: true

require_relative "lib/mcpspan/version"

Gem::Specification.new do |spec|
  spec.name = "mcpspan"
  spec.version = McpSpan::VERSION
  spec.authors = ["Kacper Zatoń"]
  spec.summary = "Self-hosted analytics for MCP servers: which tools, resources and prompts get used, " \
                 "by which client, how fast, and why they fail."
  spec.description = "Measures the tools of a server built on the official Ruby MCP SDK: which get called, by " \
                     "which client, how long they take and which fail. Parameter values never leave the process."
  spec.license = "MIT"
  spec.required_ruby_version = ">= 3.2"

  spec.files = Dir["lib/**/*.rb", "README.md", "LICENSE"]
  spec.require_paths = ["lib"]

  # No runtime dependencies: the standard library delivers, and the MCP SDK is the server's own.
  spec.homepage = "https://github.com/mcpspan/mcpspan"
  spec.metadata["source_code_uri"] = "https://github.com/mcpspan/mcpspan/tree/main/packages/mcpspan-ruby"
  spec.metadata["bug_tracker_uri"] = "https://github.com/mcpspan/mcpspan/issues"
  spec.metadata["rubygems_mfa_required"] = "true"
end
