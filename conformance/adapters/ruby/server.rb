# frozen_string_literal: true

# The conformance adapter for the Ruby SDK, on the official Ruby MCP SDK (the `mcp` gem): an MCP server over stdio
# with the tools the suite calls. The suite passes only PATH through, so the adapter names its own Gemfile.

ENV["BUNDLE_GEMFILE"] ||= File.expand_path("Gemfile", __dir__)
require "bundler/setup"
require "mcp"
require "mcpspan"

class ConformanceError < StandardError; end

def text(value, error: false)
  MCP::Tool::Response.new([{ type: "text", text: value }], error: error)
end

# Registered before the server is instrumented, as the contract requires an SDK to measure too.
class Early < MCP::Tool
  tool_name "early"

  def self.call(**) = text("ok")
end

# The gem refuses tool names over 128 characters where they are set, so this one is named past that check.
class Long < MCP::Tool
  tool_name "long"

  def self.name_value = "long_#{"x" * 295}"
  def self.call(**) = text("ok")
end

server = MCP::Server.new(name: "conformance", version: "1.0.0", tools: [Early, Long])

McpSpan.instrument(
  server,
  flush_interval: Integer(ENV.fetch("CONFORMANCE_FLUSH_MS", "200")) / 1000.0,
  capture_parameter_names: ENV["CONFORMANCE_CAPTURE_PARAMETERS"] == "1",
  capture_error_messages: ENV["CONFORMANCE_CAPTURE_ERROR_MESSAGES"] != "0",
)

server.define_tool(name: "ok") { |**| text("ok") }
server.define_tool(name: "large") { |**| text("x" * 100_000) }
server.define_tool(name: "reported_error") { |**| text("No flights found", error: true) }
server.define_tool(name: "throws") { |**| raise ConformanceError, "boom" }
server.define_tool(
  name: "typed",
  input_schema: {
    properties: { destination: { type: "string" }, passengers: { type: "number" } },
    required: %w[destination passengers],
  },
) { |**| text("ok") }
server.define_tool(name: McpSpan.exclude("excluded"), input_schema: { properties: { depth: { type: "number" } } }) do |**|
  text("ok")
end

# Resources and prompts (contract, 3.5): one resource at a fixed address, one read through a template, one that raises;
# a prompt with a required argument, and one that raises.
def text_contents(uri) = MCP::Resource::TextContents.new(uri: uri, text: "ok", mime_type: "text/plain")

server.define_resource(uri: "config://app", name: "config") { |**| text_contents("config://app") }
server.define_resource_template(uri_template: "trips://{id}", name: "trip") { |id:, **| text_contents("trips://#{id}") }
server.define_resource(uri: "broken://status", name: "broken") { |**| raise ConformanceError, "boom" }
server.define_prompt(
  name: "plan_trip",
  arguments: [MCP::Prompt::Argument.new(name: "destination", required: true)],
) do |args, **|
  message = MCP::Prompt::Message.new(role: "user", content: MCP::Content::Text.new("Plan #{args[:destination]}"))
  MCP::Prompt::Result.new(messages: [message])
end
server.define_prompt(name: "broken_prompt") { |*, **| raise ConformanceError, "boom" }

MCP::Server::Transports::StdioTransport.new(server).open
