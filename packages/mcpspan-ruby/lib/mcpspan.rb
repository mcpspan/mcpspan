# frozen_string_literal: true

require_relative "mcpspan/version"
require_relative "mcpspan/text"
require_relative "mcpspan/event"
require_relative "mcpspan/transport"
require_relative "mcpspan/reporter"
require_relative "mcpspan/collector"
require_relative "mcpspan/definitions"
require_relative "mcpspan/argument_checks"
require_relative "mcpspan/repeats"
require_relative "mcpspan/instrumentation"
require_relative "mcpspan/primitives"

# Analytics for MCP servers: which tools are called, by which client, how long they take, and which ones fail.
#
#   server = MCP::Server.new(name: "flights", tools: [SearchFlights])
#   McpSpan.instrument(server, api_key: ENV["MCPSPAN_API_KEY"], endpoint: "http://localhost:6271")
#
# Without an API key nothing is collected and nothing is sent. Parameter values never leave the process.
#
# Settings: +api_key+ (else +MCPSPAN_API_KEY+), +endpoint+, your mcpspan installation (else +MCPSPAN_ENDPOINT+; no
# default, and nothing is collected without it), +capture_parameter_names+, +capture_error_messages+ (on unless
# false), +debug+, +on_diagnostic+, +flush_on_exit+, +flush_interval+ (seconds), +max_batch_size+, +max_queue_size+.
# Nothing here raises over a setting.
module McpSpan
  @excluded_names = Set.new

  class << self
    # Tool names left out with {exclude}.
    attr_reader :excluded_names

    # Measures every tool on a server built on the `mcp` gem, whether it was added before this call or after.
    # Configures with +settings+ when given, else from the environment unless already configured. Returns the
    # server.
    def instrument(server, **settings)
      if !settings.empty?
        configure(**settings)
      elsif !collecting?
        configure
      end
      Instrumentation.instrument(server)
    rescue StandardError
      server
    end

    # Starts collecting, or stops if there is no key to collect with. Configuring again with the same settings
    # changes nothing, so a server built per request can call it every time; different settings replace the running
    # configuration, delivering what it held.
    def configure(**settings)
      Collector.configure(settings)
      nil
    rescue StandardError => e
      warn("mcpspan: could not configure (#{e.class}: #{e.message})") if settings[:debug]
      nil
    end

    # Stops collecting and delivers what is queued, ignoring any wait for a retry: it is the last chance these
    # events get. What is queued is also delivered as the program exits, so most servers need not call this.
    def shutdown
      Collector.shutdown
      nil
    rescue StandardError
      nil
    end

    # Whether an API key is configured and calls are being recorded.
    def collecting?
      Collector.collecting?
    end

    # Measures one tool class, for a server {instrument} does not cover. On an instrumented server it is counted
    # once. Returns the tool.
    def track(tool)
      if tool.respond_to?(:call) && tool.respond_to?(:name_value) && !tool.singleton_class.include?(Instrumentation::ToolHooks)
        tool.singleton_class.prepend(Instrumentation::ToolHooks)
      end
      tool
    end

    # Leaves a tool out: its calls, refused ones included, are not recorded. Takes the tool class, so a rename
    # carries the exclusion along, or its name, for a tool made with +define_tool+. Returns what it was given.
    def exclude(tool)
      if tool.is_a?(String) || tool.is_a?(Symbol)
        @excluded_names << tool.to_s
      else
        tool.instance_variable_set(:@__mcpspan_excluded, true)
      end
      tool
    end
  end
end
